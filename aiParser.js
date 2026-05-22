import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

export async function parseShiftImages(imagesB64, mimeTypes) {
  const currentYear = new Date().getFullYear();

  const content = [];
  for (let i = 0; i < imagesB64.length; i++) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: mimeTypes[i], data: imagesB64[i] },
    });
  }

  content.push({
    type: 'text',
    text: `これはRシフトというシフト管理アプリのスクリーンショットです。

画面の構成:
- 各行に日付（月/日と曜日）とシフト内容が表示されています
- 左右2列に並んでいる場合もあります
- シフト内容は「開始時間」と「終了時間」（2行で表示）、または「公休」「有休」「希望休」のテキストです
- 日付の四角が赤=日曜、青/水色=平日・土曜

現在の年: ${currentYear}
月が12→1のように減少する場合は年をまたいでいます（12月=${currentYear}年、1月=${currentYear + 1}年）

全ての日付のシフトを抽出し、以下のJSON配列のみを返してください（説明文不要）：

[
  {"year":${currentYear},"month":5,"day":16,"shift_type":"work","start_time":"11:30","end_time":"20:30","label":null},
  {"year":${currentYear},"month":5,"day":17,"shift_type":"off","start_time":null,"end_time":null,"label":"公休"}
]

shift_typeは "work"（勤務）または "off"（休み）のみ。
labelは "公休" / "有休" / "希望休" またはnull。
JSON配列のみ返してください。`,
  });

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [{ role: 'user', content }],
  });

  const raw = message.content[0].text.trim();
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) throw new Error(`AIからJSONが返されませんでした: ${raw.slice(0, 200)}`);

  const shifts = JSON.parse(match[0]);
  return shifts.filter(
    s => s.year && s.month && s.day && ['work', 'off'].includes(s.shift_type)
  );
}
