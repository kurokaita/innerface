// Builds a glyph atlas (katakana + digits/symbols) on a 2D canvas.
// The alpha channel is used as the glyph mask by the shader.
export function createGlyphAtlas() {
  const chars = [];

  // Katakana range — the classic "Matrix" look
  for (let c = 0x30A0; c <= 0x30FF; c++) chars.push(String.fromCharCode(c));

  // a few katakana extension + half-width for variety
  for (let c = 0xFF66; c <= 0xFF9D; c++) chars.push(String.fromCharCode(c));

  // latin / digits / symbols
  const extras = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ:.\"=*+-<>|/\\[]{}';
  for (const ch of extras) chars.push(ch);

  const GLYPHS = chars.slice(0, 96);

  const COLS = 16;
  const ROWS = Math.ceil(GLYPHS.length / COLS);
  const CW = 20;
  const CH = 28;

  const canvas = document.createElement('canvas');
  canvas.width = COLS * CW;
  canvas.height = ROWS * CH;
  const ctx = canvas.getContext('2d');

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `bold ${CH - 8}px "SF Mono", Menlo, Consolas, monospace`;

  GLYPHS.forEach((ch, i) => {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    ctx.fillText(ch, col * CW + CW / 2, row * CH + CH / 2 + 1);
  });

  return {
    canvas,
    grid: [COLS, ROWS],
    count: GLYPHS.length,
  };
}
