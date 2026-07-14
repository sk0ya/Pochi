import { useCallback, useEffect, useState } from 'react';
import { deleteFile, duplicateFile, listFiles, newFile, pickFolder, renameFile } from '../bridge';
import type { FolderFile } from '../bridge';

/** Blank Pochi document, written when creating a new file (matches App's save envelope). */
const BLANK_CONTENT = JSON.stringify(
  { app: 'pochi', version: 1, doc: { shapes: [], connectors: [] } },
  null,
  2,
);

/** Desktop-only file manager: pick a working folder, then browse/open/create/rename/
 * duplicate/delete the diagram files in it. The chosen folder path is persisted by App
 * (FILES_FOLDER_KEY) and passed in; every mutation refreshes the list from disk so the
 * panel always mirrors the real folder rather than a cached view.
 *
 * `activePath` is the currently-open file (App's state.fileName), highlighted in the list. */
export function FilesSidebar({
  folder,
  onPickFolder,
  activePath,
  onOpenFile,
  onFileRenamed,
  onFileDeleted,
}: {
  folder: string | null;
  onPickFolder: (dir: string) => void;
  activePath: string | null;
  onOpenFile: (path: string) => void;
  /** Called when the currently-open file's path changed on disk (rename), so App can
   * keep state.fileName in sync (otherwise the next Save would write to the old path). */
  onFileRenamed: (oldPath: string, newPath: string) => void;
  onFileDeleted: (path: string) => void;
}) {
  const [files, setFiles] = useState<FolderFile[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!folder) return;
    const res = await listFiles(folder);
    if (!res) {
      setError('フォルダが見つかりません');
      setFiles([]);
      return;
    }
    setError(null);
    setFiles(res.files);
  }, [folder]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const choose = async () => {
    const dir = await pickFolder(folder ?? undefined);
    if (dir) onPickFolder(dir);
  };

  const create = async () => {
    if (!folder) return;
    const name = window.prompt('新しいファイル名', 'diagram.pochi.json');
    if (!name) return;
    // Ensure a diagram extension so it lists and opens cleanly.
    const full = /\.(pochi\.json|json|excalidraw)$/i.test(name) ? name : `${name}.pochi.json`;
    const path = await newFile(folder, full, BLANK_CONTENT);
    await refresh();
    if (path) onOpenFile(path);
  };

  const rename = async (f: FolderFile) => {
    const name = window.prompt('新しいファイル名', f.name);
    if (!name || name === f.name) return;
    const res = await renameFile(f.path, name);
    if (res && typeof res === 'object' && 'error' in res) {
      window.alert('同名のファイルが既に存在します');
      return;
    }
    if (typeof res === 'string') {
      if (f.path === activePath) onFileRenamed(f.path, res);
      await refresh();
    }
  };

  const duplicate = async (f: FolderFile) => {
    await duplicateFile(f.path);
    await refresh();
  };

  const remove = async (f: FolderFile) => {
    if (!window.confirm(`「${f.name}」を削除しますか?`)) return;
    if (await deleteFile(f.path)) {
      if (f.path === activePath) onFileDeleted(f.path);
      await refresh();
    }
  };

  return (
    <div className="files-sidebar">
      <div className="files-header">
        <span className="files-folder" title={folder ?? undefined}>
          {folder ? folderName(folder) : 'フォルダ未選択'}
        </span>
        <button className="files-icon-btn" title="フォルダを開く" onClick={() => void choose()}>
          📂
        </button>
        {folder && (
          <button className="files-icon-btn" title="更新" onClick={() => void refresh()}>
            ⟳
          </button>
        )}
      </div>

      {!folder && (
        <div className="files-empty">
          <button className="files-pick" onClick={() => void choose()}>
            フォルダを選択
          </button>
          <p>作業フォルダを選ぶと、その中の図面ファイルを一覧・管理できます。</p>
        </div>
      )}

      {folder && (
        <>
          <div className="files-list">
            {error && <div className="files-error">{error}</div>}
            {!error && files.length === 0 && <div className="files-error">ファイルがありません</div>}
            {files.map((f) => (
              <div
                key={f.path}
                className={`files-item${f.path === activePath ? ' active' : ''}`}
                title={f.path}
                onClick={() => onOpenFile(f.path)}
              >
                <span className="files-name">{f.name}</span>
                <span className="files-actions">
                  <button title="複製" onClick={stop(() => void duplicate(f))}>⧉</button>
                  <button title="名前を変更" onClick={stop(() => void rename(f))}>✎</button>
                  <button title="削除" onClick={stop(() => void remove(f))}>🗑</button>
                </span>
              </div>
            ))}
          </div>
          <button className="files-new" onClick={() => void create()}>
            ＋ 新規ファイル
          </button>
        </>
      )}
    </div>
  );
}

/** Wrap a row-button handler so its click doesn't also bubble up to the row's open-on-click. */
function stop(fn: () => void) {
  return (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
  };
}

function folderName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || path;
}
