import { PACKAGE_NAME, VERSION } from "./constants.js";

/** Stable update-check response matching Even Terminal's `/api/update-check`. */
export function currentUpdateInfo(): Record<string, unknown> {
  return {
    packageName: PACKAGE_NAME,
    currentVersion: VERSION,
    newestVersion: VERSION,
    updateAvailable: false,
    checkedAt: new Date().toISOString(),
  };
}
