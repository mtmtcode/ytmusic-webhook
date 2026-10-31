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

## LaMetric TIME

- **LaMetric TIME**（Notification）：曲変更時に一時的な通知を表示します。既存の通知プリセットです。
- **LaMetric TIME - My Data DIY**：My Data DIYの通常のアプリ画面に曲情報を保持・更新します。

My Data DIYの設定手順：

1. LaMetric TIMEにMy Data DIYをインストールし、アプリ設定で **HTTP Push** を選択します。
2. 拡張の設定で送信先を追加し、プリセットを **LaMetric TIME - My Data DIY** に変更します。
3. POST先URLの `<DEVICE_IP>` と `<WIDGET_ID>` を、山括弧ごと端末のIPアドレスとアプリ設定に表示されるWidget ID（Push URLの末尾）に置き換えます。
   `http://<DEVICE_IP>:8080/api/v2/widget/update/com.lametric.diy.devwidget/<WIDGET_ID>`
   アプリに表示される実際のPush URLを優先してください。URLは通常の入力欄で編集・保存できます。
4. Basic認証のユーザー名は `dev`。パスワード欄に自身の **Device API Key** を入力します（[デバイス管理](https://developer.lametric.com/user/devices)で取得）。
5. 全体と送信先をONにし「すべて保存」。必要なら接続テストでサンプル曲を送信します。

POST / `application/json` で、ルート直下の `frames` に曲名とアーティストを送ります。通知用の `priority`・`model`・`cycles` は含めません。認証情報は既存の仕組みでローカルに保存します。HTTPは信頼できるLANで利用してください。

PushしてもMy Data DIYへの画面切り替えは自動では行いません。曲変更イベントで更新するため、再生停止後も最後の曲情報が残る場合があります。停止検知やアプリの自動切り替えは行いません。

仕様確認：[公式のHTTP Push説明](https://help.lametric.com/support/solutions/articles/6000268373-my-data-diy-no-code-capabilities-)・[JSON形式](https://help.lametric.com/support/solutions/articles/6000225467-my-data-diy)・[Device APIのURLと認証](https://docs.lametric.com/en/latest/reference-docs/device-discovery.html)。My Data DIY固有のパスとWidget IDの扱いは[既存のPush実装例](https://community.homey.app/t/lametric-sky-display-local-http-push/116423)でも確認しています。
