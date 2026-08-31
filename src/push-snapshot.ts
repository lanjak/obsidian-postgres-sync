export interface PushSnapshot {
  path: string;
  content: string;
  contentHash: string;
  mtime: number;
  size: number;
}

interface SnapshotFile {
  path: string;
  stat: {
    mtime: number;
  };
}

export interface RemotePushState {
  contentHash: string;
  mtime: number;
  deleted: boolean;
}

export type PushSnapshotDecision = "retry" | "none" | "pull" | "push";

export async function readPushSnapshot<TFile extends SnapshotFile>(
  file: TFile,
  read: (file: TFile) => Promise<string>,
  hash: (content: string) => Promise<string>,
): Promise<PushSnapshot> {
  const content = await read(file);
  const mtime = file.stat.mtime;
  const contentHash = await hash(content);
  return { path: file.path, content, contentHash, mtime, size: content.length };
}

export function decidePushSnapshot(
  snapshot: PushSnapshot,
  currentContent: string,
  remote: RemotePushState | undefined,
): PushSnapshotDecision {
  if (currentContent !== snapshot.content) return "retry";
  if (remote && !remote.deleted && remote.contentHash === snapshot.contentHash) return "none";
  if (remote && remote.mtime >= snapshot.mtime) return "pull";
  return "push";
}

export async function checkPushSnapshot<TRemote extends RemotePushState>(
  snapshot: PushSnapshot,
  readCurrentContent: () => Promise<string | undefined>,
  readRemote: () => Promise<TRemote | undefined>,
): Promise<{ decision: PushSnapshotDecision | "missing"; remote: TRemote | undefined }> {
  const remote = await readRemote();
  const currentContent = await readCurrentContent();
  if (currentContent === undefined) return { decision: "missing", remote };
  return { decision: decidePushSnapshot(snapshot, currentContent, remote), remote };
}
