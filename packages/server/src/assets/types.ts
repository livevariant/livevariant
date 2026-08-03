/**
 * Asset storage contract, pluggable the same way StateStore is: the
 * bundled MemoryAssetStore backs dev and tests, the Cloudflare deployment
 * binds R2, and any other backend is an adapter away.
 *
 * Deliberately tiny. Everything interesting (content addressing, signed
 * URLs, size and type limits) lives ABOVE this interface, which is what
 * lets a filesystem or S3 adapter inherit the whole protection story by
 * implementing two methods. An adapter must never serve bytes on a public
 * URL of its own: the only way to an asset is our signed /a route.
 */
export interface StoredAsset {
  body: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array;
  contentType: string;
  size: number;
}

export interface AssetStore {
  /**
   * Stores bytes under an id. Ids are content hashes, so overwriting an
   * existing id with the same bytes must be harmless; adapters need no
   * atomicity here beyond not corrupting the object.
   */
  put(id: string, data: Uint8Array, contentType: string): Promise<void>;

  /** null when the id is unknown. */
  get(id: string): Promise<StoredAsset | null>;

  /**
   * Optional: a presigned URL on the backend's own infrastructure, valid
   * for roughly ttlSeconds. When present, /a redirects there instead of
   * streaming, for backends where relaying bytes costs real money (S3
   * behind a Node host pays egress twice). On Cloudflare bandwidth is
   * free and streaming is the better default, so the R2 adapter does not
   * implement this.
   */
  redirectUrl?(id: string, ttlSeconds: number): Promise<string | null>;
}

/** In-memory reference implementation: dev, tests, and the contract. */
export class MemoryAssetStore implements AssetStore {
  /** Settable in tests to exercise the presign escape hatch. */
  redirectUrl?: (id: string, ttlSeconds: number) => Promise<string | null>;

  private objects = new Map<
    string,
    { bytes: Uint8Array; contentType: string }
  >();

  async put(id: string, data: Uint8Array, contentType: string): Promise<void> {
    this.objects.set(id, { bytes: data, contentType });
  }

  async get(id: string): Promise<StoredAsset | null> {
    const found = this.objects.get(id);
    if (!found) {
      return null;
    }
    return {
      body: found.bytes,
      contentType: found.contentType,
      size: found.bytes.byteLength
    };
  }
}
