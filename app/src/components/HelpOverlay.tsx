import type { Dispatch } from 'react';
import type { Action } from '../state/reducer';

const rows: Array<[string, string]> = [
  ['h j k l / 矢印', 'カーソル移動(カウント可: 5l)'],
  ['r / e', '四角 / 楕円を描く(hjklでサイズ調整 → Enter)'],
  ['a', '矢印。図形の上で押すと接続矢印(図形に追従)'],
  ['t / i', 'テキスト作成 / カーソル下の図形のテキスト編集'],
  ['Shift+ドラッグ / クリック', '複数選択(VISUAL)。v/d/y/p などが選択全体に効く'],
  ['v', '図形を移動(選択があれば選択全体, なければカーソル下)(hjkl → Enter)'],
  ['s', 'カーソル下の図形をリサイズ(hjkl → Enter)'],
  ['d / x', 'カーソル下の図形・矢印を削除'],
  ['y / p', 'ヤンク / カーソル位置にペースト'],
  ['u / Ctrl+r', 'アンドゥ / リドゥ'],
  ['Enter', 'カーソル下の図形を選択'],
  ['Esc', 'キャンセル / 選択解除'],
  [': ', 'コマンド (:w :o :svg :new :vim off :q)'],
  ['右クリック', 'コンテキストメニュー:色・複製・削除・前面/背面へ'],
  ['Ctrl+C / V / D', 'コピー / 貼り付け / 複製(vim/マウス両対応)'],
  ['マウス(✏ Auto)', '手描きすると自動判定: 丸→楕円, 角→四角, 線→矢印(図形間は接続)。作成後すぐテキスト編集'],
  ['マウス(図形ツール)', '空白をドラッグ=その図形を描く, 図形をドラッグ=移動'],
  ['パン/ズーム', '中ボタン or Space+ドラッグ or ホイール=パン, Ctrl+ホイール=ズーム'],
  ['Fit ボタン / %クリック', '全体を画面に収める / ズームを100%にリセット'],
  ['ダブルクリック', '空白=四角を作成して編集, 図形=テキスト編集'],
];

export function HelpOverlay({ dispatch }: { dispatch: Dispatch<Action> }) {
  return (
    <div className="help-overlay" onClick={() => dispatch({ type: 'TOGGLE_HELP' })}>
      <div className="help-panel" onClick={(e) => e.stopPropagation()}>
        <h2>Pochi — keys</h2>
        <table>
          <tbody>
            {rows.map(([k, desc]) => (
              <tr key={k}>
                <td className="key">{k}</td>
                <td>{desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="help-foot">? または Esc で閉じる</p>
      </div>
    </div>
  );
}
