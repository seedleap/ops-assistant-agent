export interface RemoteSkillRef {
  id: string;
  version: string;
}

export interface SkillManifest extends RemoteSkillRef {
  packageKey: string;
  sha256: string;
  sizeBytes?: number;
}
