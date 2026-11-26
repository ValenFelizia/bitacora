export function makeManifest(options: {
  version: string;
  notes: string;
  date: Date;
  arch: "x64" | "arm64";
  installer: string;
  signature: string;
}): {
  version: string;
  notes: string;
  pub_date: string;
  platforms: Record<string, { url: string; signature: string }>;
};

export function releaseHead(cwd: string, version: string): Promise<string>;
export function verifyInstaller(installer: string, signature: string, publicKey: string, version: string): Promise<string>;
export function verifyBuildInfo(info: unknown, expected: { version: string; head: string; sha256: string }): void;
export function verifyReleaseVersion(version: string, releases: readonly { draft: boolean; tag_name: string }[]): void;
