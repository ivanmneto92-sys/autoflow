/** Preparação de imagens antes do envio (JPG no formato aceito pelo Instagram). */

/**
 * Converte para JPG e ajusta a proporção. `ratio` força uma proporção exata (carrossel: todos iguais ao 1º item,
 * senão o Instagram corta os outros sozinho).
 */
export async function prepareImage(file: File, ratio?: number): Promise<{ blob: Blob; adjusted: boolean; ratio: number }> {
  const src = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('Não consegui abrir essa imagem. Use JPG ou PNG.'));
      i.src = src;
    });
    let sw = img.naturalWidth;
    let sh = img.naturalHeight;
    let sx = 0;
    let sy = 0;
    const own = sw / sh;
    const target = ratio ?? Math.min(1.91, Math.max(0.8, own)); // feed: entre 4:5 e 1,91:1
    let adjusted = false;
    if (Math.abs(own - target) > 0.01) {
      adjusted = true;
      if (own < target) {
        const h = Math.round(sw / target); // mais alta que o alvo → corta em cima e embaixo
        sy = Math.round((sh - h) / 2);
        sh = h;
      } else {
        const w = Math.round(sh * target); // mais larga → corta nas laterais
        sx = Math.round((sw - w) / 2);
        sw = w;
      }
    }
    const scale = Math.min(1, 1440 / sw);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(sw * scale);
    canvas.height = Math.round(sh * scale);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff'; // PNG com transparência vira fundo branco
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Falha ao converter a imagem'))), 'image/jpeg', 0.9),
    );
    return { blob, adjusted, ratio: target };
  } finally {
    URL.revokeObjectURL(src);
  }
}
