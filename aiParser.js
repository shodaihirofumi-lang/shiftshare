import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

// 診断用: 直近のシフト解析の生応答などを保持
let _lastShiftDebug = null;
export function getShiftParseDebug() { return _lastShiftDebug; }

export async function parseShiftImages(imagesB64, mimeTypes) {
  const currentYear = new Date().getFullYear();
  _lastShiftDebug = { at: new Date().toISOString(), images: imagesB64.length, mimeTypes, model: 'claude-sonnet-5' };

  const content = [];
  for (let i = 0; i < imagesB64.length; i++) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: mimeTypes[i], data: imagesB64[i] },
    });
  }

  content.push({
    type: 'text',
    text: `これはシフト管理アプリ（勤務表・シフト申請アプリ）のスクリーンショットです。数枚に分かれていることがあります。写っているシフト表をすべて正確にデータ化するのがあなたの仕事です。

【画面の構成（アプリによって少しずつ違います）】
- 画面の上部に「対象期間（例: 2026/09/16(水)〜10/15(木)）」が書かれていることがあります。ここから何年・何月〜何月の表かを判断してください。多くの職場は毎月16日〜翌月15日が1区切りです。
- 「管理者コメント」「申請者コメント」などの欄、「申請済」「再申請」「キャンセル」などのボタン、「--- PAGE 1 ---」等のページ区切りは、シフトデータではありません。無視してください。
- 各セルに「日付（月/日と曜日）」と、その日の「シフト内容」が入っています。
- セルは左右2列（またはそれ以上）に並ぶことがあります。多くは「縦＝曜日、横＝週」のカレンダー状の並びです。順序に惑わされず、日付そのものを読んで、最終的に日付の小さい順（16日→翌15日）に並べて出力してください。
- 中身が何も無いグレー/空白のセルは、期間外の埋め合わせなので出力しないでください。
- シフト内容は次のいずれかです:
  - 勤務日: 「開始時間」と「終了時間」が上下2段で表示されます（例: 上段 6:15 / 下段 20:30）。
  - 休み: 「公休」「有休」「希望休」などのテキストが表示されます。
- 日付の四角の色: 赤=日曜（または祝日）、青/水色=平日・土曜。曜日の判断だけに使い、色は出力しません。

【正確に読み取るための注意（重要）】
- 時刻は24時間表記です。数字を1桁ずつ慎重に読み、「9と8」「3と8」「0と6」「1と7」「5と6」の見間違いに特に注意してください。
- 区切りが「:」「.」のどれでも、または無くても、同じ時刻として解釈してください（例: 6.15 / 615 → 06:15）。
- 夜勤などで終了時刻が開始より早い場合は翌日にまたぐ勤務です。見えているとおり start/end に入れてください（例: 22:00〜翌6:00 なら start 22:00 / end 06:00）。
- 「有休」は読み飛ばさず、必ず shift_type="off"・label="有休" として確実に拾ってください。「公休」「希望休」も同様に正確に区別してください。
- 表に写っている日付は1日も飛ばさず、すべて出力してください。内容が空欄（予定なし）の日だけは出力不要です。
- 複数の画像が渡された場合、それらは同じ期間の続き（一部が重複していることもあります）です。全画像を突き合わせ、同じ日付は1つにまとめて（重複させずに）、期間全体を出力してください。
- 推測で時刻を補完しないでください。読み取れた数字のみを使ってください。

【年について】
現在の年: ${currentYear}
上部の対象期間の表記を最優先に使ってください。表記が無い場合、月が 12→1 のように減少する箇所は年をまたいでいます（12月=${currentYear}年、1月=${currentYear + 1}年）。

【出力】
前置き・説明・コードブロックは一切書かず、次の形式のJSON配列だけを返してください:
[
  {"year":${currentYear},"month":5,"day":16,"shift_type":"work","start_time":"11:30","end_time":"20:30","label":null},
  {"year":${currentYear},"month":5,"day":17,"shift_type":"off","start_time":null,"end_time":null,"label":"公休"},
  {"year":${currentYear},"month":5,"day":18,"shift_type":"off","start_time":null,"end_time":null,"label":"有休"}
]

- shift_type は "work"（勤務）または "off"（休み）のみ。
- start_time / end_time は "HH:MM" 形式。休みの日は null。
- label は休みの日のみ "公休" / "有休" / "希望休" のいずれか、勤務日は null。
- JSON配列のみ返してください。`,
  });

  let message;
  try {
    message = await client.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 8192,
      messages: [
        { role: 'user', content },
        { role: 'assistant', content: '[' }, // JSON配列の出力を強制（プリフィル）
      ],
    });
  } catch (e) {
    _lastShiftDebug.error = 'API呼び出し失敗: ' + (e?.message || e);
    _lastShiftDebug.status = e?.status;
    throw e;
  }

  // 全テキストブロックを結合（thinking等が混じっても拾えるように）
  const textOut = (message.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  // プリフィルの "[" を先頭に補って配列を完成させる
  const raw = ('[' + textOut).trim();
  _lastShiftDebug.rawSample = raw.slice(0, 2000);
  _lastShiftDebug.stopReason = message.stop_reason;
  _lastShiftDebug.blocks = (message.content || []).map(b => b.type);
  _lastShiftDebug.usage = message.usage;
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) { _lastShiftDebug.error = 'JSON配列なし'; throw new Error(`AIからJSONが返されませんでした: ${raw.slice(0, 200)}`); }

  let shifts;
  try { shifts = JSON.parse(match[0]); }
  catch (e) { _lastShiftDebug.error = 'JSON.parse失敗: ' + e.message; throw new Error('AIの返答を解析できませんでした'); }

  const result = shifts
    .filter(s => s.year && s.month && s.day && ['work', 'off'].includes(s.shift_type))
    .map(s => ({
      year: Number(s.year),
      month: Number(s.month),
      day: Number(s.day),
      shift_type: s.shift_type,
      start_time: s.shift_type === 'work' ? normTime(s.start_time) : null,
      end_time: s.shift_type === 'work' ? normTime(s.end_time) : null,
      label: s.shift_type === 'off' ? normLabel(s.label) : null,
    }));
  _lastShiftDebug.parsedCount = shifts.length;
  _lastShiftDebug.resultCount = result.length;
  return result;
}

// "1130" / "11.30" / "11時30分" / "11" などを "HH:MM" に正規化
function normTime(t) {
  if (t == null) return null;
  let s = String(t).trim();
  if (!s) return null;
  s = s.replace(/時/, ':').replace(/分/, '').replace(/[.．：]/g, ':');
  let m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m) return `${m[1].padStart(2, '0')}:${m[2]}`;
  m = s.match(/^(\d{1,2})(\d{2})$/); // 1130
  if (m) return `${m[1].padStart(2, '0')}:${m[2]}`;
  m = s.match(/^(\d{1,2})$/); // 時だけ
  if (m) return `${m[1].padStart(2, '0')}:00`;
  return s;
}

// 休みラベルを公休/有休/希望休に正規化（不明は公休）
function normLabel(label) {
  const s = String(label || '').trim();
  if (s.includes('有')) return '有休';
  if (s.includes('希望')) return '希望休';
  if (s.includes('公')) return '公休';
  return s || '公休';
}

// レシートやPayPay等の決済画面から支払合計金額を読み取る
export async function parseExpenseAmount(imageB64, mimeType) {
  const content = [
    { type: 'image', source: { type: 'base64', media_type: mimeType, data: imageB64 } },
    { type: 'text', text: `これはレシート、またはPayPay等のキャッシュレス決済アプリの支払い画面のスクリーンショットです。
この画像から「支払った合計金額（日本円）」を1つだけ読み取ってください。
- レシートの場合は「合計」「お会計」の金額
- 決済アプリの場合は支払い金額
次のJSONのみ返してください（説明不要、数字のみ・カンマや円記号なし）：
{"amount": 1980}
金額が読み取れない場合は {"amount": null} を返してください。` },
  ];
  const message = await client.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 256,
    messages: [{ role: 'user', content }],
  });
  const raw = message.content[0].text.trim();
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`AIから金額が返されませんでした: ${raw.slice(0, 200)}`);
  const obj = JSON.parse(match[0]);
  return Number.isFinite(obj.amount) ? Math.round(obj.amount) : null;
}
