export interface BrowserTransport {
  hostname: string;
  protocol: string;
}

export function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "127.0.0.1" ||
    hostname === "localhost" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

/**
 * Browser secrets may cross plain HTTP only over the node's loopback boundary.
 * A remote deployment must terminate HTTPS before this UI will expose any
 * authenticated or mutating surface.
 */
export function allowsSensitiveBrowserTransport(
  transport: BrowserTransport,
): boolean {
  return (
    transport.protocol === "https:" ||
    isLoopbackHostname(transport.hostname)
  );
}
