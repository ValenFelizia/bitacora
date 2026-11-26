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
