# YouTube Music Webhook

YouTube Musicの曲変更を検知し、好きなURLへJSONをPOSTするChrome拡張。

## インストール

1. [ZIPをダウンロード](https://github.com/mtmtcode/ytmusic-webhook/archive/refs/heads/main.zip)して展開するか、`git clone`。
2. Chromeで `chrome://extensions` を開き、デベロッパーモードをON。
3. 「パッケージ化されていない拡張機能を読み込む」で、このフォルダーを選択。
4. YouTube Musicのタブを再読み込み。

## 設定

拡張アイコンから送信先を追加し、URL・認証・JSONを設定。全体と送信先の通知をONにして「すべて保存」。

変数は `{{title}}`（曲名）、`{{artist}}`（アーティスト）、`{{source}}`（`youtube-music`）。

## 更新

`git pull`（ZIPなら同じフォルダーに上書き）→ `chrome://extensions` で拡張の↻ → YouTube Musicのタブを再読み込み。

開発・実装のメモは [AGENTS.md](AGENTS.md)。
