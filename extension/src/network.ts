import { readFile } from "node:fs/promises";
import { rootCertificates } from "node:tls";
import { Agent, ProxyAgent, fetch as request } from "undici";
import type { Profile } from "./model.js";
import { AppError } from "../../src/errors.js";
export async function createNetwork(profile: Profile) {
  let ca: string[] | undefined;
  if (profile.caFile) {
    try {
      const pem = await readFile(profile.caFile, "utf8");
      if (!pem.includes("-----BEGIN CERTIFICATE-----")) throw Error();
      ca = [...rootCertificates, pem];
    } catch {
      throw new AppError(
        "INVALID_CA",
        "Cannot read the selected PEM certificate bundle.",
      );
    }
  }
  const tls = ca
    ? { ca, rejectUnauthorized: true }
    : { rejectUnauthorized: true };
  const dispatcher = profile.proxy
    ? new ProxyAgent({ uri: profile.proxy, requestTls: tls, proxyTls: tls })
    : new Agent({ connect: tls });
  const fetcher: typeof fetch = async (input, init) => {
    // Adapter boundary: Undici and Node DOM Response types differ, the runtime contract is Fetch.
    return (await request(String(input), { ...init, dispatcher } as Parameters<
      typeof request
    >[1])) as unknown as Response;
  };
  return { fetcher, close: () => dispatcher.close() };
}
