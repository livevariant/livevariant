import { createClient } from "redis";
import type { AssignmentRecord, DerivedState } from "@livevariant/core";
import { counterKey, linearKey, type StateStore } from "./types.js";
import { derivedToArtifacts } from "./snapshot.js";

type RedisClient = ReturnType<typeof createClient>;

/**
 * Redis-backed store for Node self-hosting. Layout:
 *   a:{testId}   hash: idHash -> AssignmentRecord JSON
 *   c:{testId}:{scope} hash: counter index -> value (HINCRBY-atomic)
 *   ck:{testId}  set of counter scopes (so replaceDerived can find them)
 *   l:{testId}   JSON envelope { version, data } for linear state (CAS via Lua)
 */

/** Atomic reward accumulation on one assignment record. */
const REWARD_SCRIPT = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then return false end
local rec = cjson.decode(raw)
local first = 0
if rec.rewardTotal == 0 then first = 1 end
rec.rewardTotal = rec.rewardTotal + tonumber(ARGV[2])
local encoded = cjson.encode(rec)
redis.call('HSET', KEYS[1], ARGV[1], encoded)
return {first, encoded}
`;

/** Compare-and-set on the versioned blob envelope. */
const BLOB_CAS_SCRIPT = `
local cur = redis.call('GET', KEYS[1])
local ver = 0
if cur then ver = tonumber(cjson.decode(cur).version) end
if ver ~= tonumber(ARGV[1]) then return 0 end
redis.call('SET', KEYS[1], cjson.encode({version = ver + 1, data = ARGV[2]}))
return 1
`;

/** Unconditional blob replace that still bumps the version atomically. */
const BLOB_REPLACE_SCRIPT = `
local cur = redis.call('GET', KEYS[1])
local ver = 0
if cur then ver = tonumber(cjson.decode(cur).version) end
if ARGV[1] == '' then
  redis.call('DEL', KEYS[1])
else
  redis.call('SET', KEYS[1], cjson.encode({version = ver + 1, data = ARGV[1]}))
end
return ver + 1
`;

export class RedisStore implements StateStore {
  constructor(private client: RedisClient) {}

  static async connect(url: string): Promise<RedisStore> {
    const client = createClient({ url });
    await client.connect();
    return new RedisStore(client);
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  async getAssignment(
    testId: string,
    idHash: string
  ): Promise<AssignmentRecord | null> {
    const raw = await this.client.hGet(`a:${testId}`, idHash);
    return raw ? (JSON.parse(raw) as AssignmentRecord) : null;
  }

  async putAssignmentIfAbsent(
    testId: string,
    idHash: string,
    rec: AssignmentRecord
  ): Promise<{ rec: AssignmentRecord; created: boolean }> {
    const created = await this.client.hSetNX(
      `a:${testId}`,
      idHash,
      JSON.stringify(rec)
    );
    if (created) {
      return { rec, created: true };
    }
    const winner = await this.getAssignment(testId, idHash);
    // The field can only have been written, never deleted, so a lost race
    // always leaves a readable winner.
    return { rec: winner ?? rec, created: false };
  }

  async addReward(
    testId: string,
    idHash: string,
    amount: number
  ): Promise<{ rec: AssignmentRecord; first: boolean } | null> {
    const reply = (await this.client.eval(REWARD_SCRIPT, {
      keys: [`a:${testId}`],
      arguments: [idHash, String(amount)]
    })) as [number, string] | null;
    if (!reply) {
      return null;
    }
    return { first: reply[0] === 1, rec: JSON.parse(reply[1]) };
  }

  async *scanAssignments(testId: string): AsyncIterable<AssignmentRecord> {
    let cursor = "0";
    do {
      const { cursor: next, entries } = await this.client.hScan(
        `a:${testId}`,
        cursor,
        { COUNT: 500 }
      );
      cursor = next;
      for (const { value } of entries) {
        yield JSON.parse(value) as AssignmentRecord;
      }
    } while (cursor !== "0");
  }

  async incrCounters(key: string, deltas: number[]): Promise<void> {
    const multi = this.client.multi();
    // Track the scope so replaceDerived can enumerate this test's keys.
    const [, testId, ...scope] = key.split(":");
    multi.sAdd(`ck:${testId}`, scope.join(":"));
    for (let i = 0; i < deltas.length; i++) {
      if (deltas[i] !== 0) {
        multi.hIncrBy(key, String(i), deltas[i]);
      }
    }
    await multi.exec();
  }

  async getCounters(key: string, length: number): Promise<number[]> {
    const fields = Array.from({ length }, (_, i) => String(i));
    const values = await this.client.hmGet(key, fields);
    return values.map(v => (v === null ? 0 : Number(v)));
  }

  async getBlob(
    key: string
  ): Promise<{ data: string; version: number } | null> {
    const raw = await this.client.get(key);
    if (!raw) {
      return null;
    }
    const envelope = JSON.parse(raw) as { version: number; data: string };
    return { data: envelope.data, version: envelope.version };
  }

  async putBlob(
    key: string,
    data: string,
    expectedVersion: number
  ): Promise<boolean> {
    const reply = (await this.client.eval(BLOB_CAS_SCRIPT, {
      keys: [key],
      arguments: [String(expectedVersion), data]
    })) as number;
    return reply === 1;
  }

  async replaceDerived(testId: string, state: DerivedState): Promise<void> {
    const scopes = await this.client.sMembers(`ck:${testId}`);
    const { counters, blob } = derivedToArtifacts(testId, state);

    const multi = this.client.multi();
    for (const scope of scopes) {
      multi.del(counterKey(testId, scope));
    }
    multi.del(`ck:${testId}`);
    for (const [key, values] of counters) {
      const [, , ...scope] = key.split(":");
      multi.sAdd(`ck:${testId}`, scope.join(":"));
      const fields: Record<string, string> = {};
      values.forEach((v, i) => {
        fields[String(i)] = String(v);
      });
      multi.hSet(key, fields);
    }
    await multi.exec();

    await this.client.eval(BLOB_REPLACE_SCRIPT, {
      keys: [linearKey(testId)],
      arguments: [blob ?? ""]
    });
  }
}
