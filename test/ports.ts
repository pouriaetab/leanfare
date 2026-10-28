// A port nothing on this computer listens on, for a test that starts Leanfare itself: the system picks it,
// and it is let go again just before the test starts Leanfare there. A random port from a fixed range can
// be taken by another program, and then the test reads that program's answers as Leanfare's.
import { createServer, type AddressInfo } from "node:net";

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });
}
