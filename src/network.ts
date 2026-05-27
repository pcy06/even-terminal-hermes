import { networkInterfaces } from "node:os";

/** Return the first non-loopback IPv4 address for the pairing URL. */
export function getLanAddress(): string {
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces || []) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return "";
}
