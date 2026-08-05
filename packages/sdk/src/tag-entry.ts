/**
 * IIFE entry for the served /sdk.js bundle. Nothing but the boot call
 * lives here so the tag module itself stays importable and testable.
 */
import { bootTag } from "./tag.js";

bootTag();
