/** Local-only photo framing. No network request or upload is made here. */
export const PHOTO_MAX_BYTES = 10 * 1024 * 1024;
export function photoCanvasSize(width: number, height: number) {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  )
    throw Error("無法讀取照片尺寸。");
  const scale = Math.min(1, 1440 / Math.max(width, height));
  const photoWidth = Math.max(1, Math.round(width * scale));
  const photoHeight = Math.max(1, Math.round(height * scale));
  return {
    photoWidth,
    photoHeight,
    width: Math.max(480, photoWidth + 48),
    height: photoHeight + 160,
  };
}
export function validatePhoto(file: Pick<File, "type" | "size">) {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type))
    throw Error("請選擇 JPEG、PNG 或 WebP 照片。");
  if (file.size <= 0 || file.size > PHOTO_MAX_BYTES)
    throw Error("照片需大於 0 且不超過 10 MB。");
}
export function mountPhotoFrame(
  host: HTMLElement,
  event: { title: string; starts_at: string },
) {
  let disposed = false;
  let generation = 0;
  let sourceUrl: string | null = null;
  let outputUrl: string | null = null;
  const releaseSource = () => {
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    sourceUrl = null;
  };
  const releaseOutput = () => {
    if (outputUrl) URL.revokeObjectURL(outputUrl);
    outputUrl = null;
  };
  host.innerHTML =
    '<label class="public-photo-picker">選擇照片（JPEG / PNG / WebP，最多 10 MB）<input type="file" accept="image/jpeg,image/png,image/webp"></label><p role="status" aria-live="polite"></p><canvas class="public-photo-preview" hidden aria-label="活動相框預覽"></canvas><a class="public-photo-download" hidden download="meetup-photo.png">下載 PNG</a>';
  const input = host.querySelector<HTMLInputElement>("input")!;
  const status = host.querySelector<HTMLElement>('[role="status"]')!;
  const canvas = host.querySelector<HTMLCanvasElement>("canvas")!;
  const download = host.querySelector<HTMLAnchorElement>("a")!;
  function fitText(
    ctx: CanvasRenderingContext2D,
    text: string,
    maxWidth: number,
  ) {
    let value = text;
    if (ctx.measureText(value).width <= maxWidth) return value;
    const points = Array.from(text);
    while (
      points.length &&
      ctx.measureText(points.join("") + "…").width > maxWidth
    )
      points.pop();
    return points.join("") + "…";
  }
  input.onchange = async () => {
    const current = ++generation;
    releaseSource();
    releaseOutput();
    canvas.hidden = true;
    download.hidden = true;
    download.removeAttribute("href");
    const file = input.files?.[0];
    if (!file) {
      status.textContent = "尚未選擇照片。";
      return;
    }
    const active = () => !disposed && current === generation;
    try {
      validatePhoto(file);
      status.textContent = "正在本機製作相框…";
      const url = URL.createObjectURL(file);
      sourceUrl = url;
      const photo = new Image();
      photo.src = url;
      try {
        await photo.decode();
      } finally {
        URL.revokeObjectURL(url);
        if (sourceUrl === url) sourceUrl = null;
      }
      if (!active()) return;
      if (photo.naturalWidth * photo.naturalHeight > 40_000_000)
        throw Error("照片解析度過大，請先縮小至 4,000 萬像素以下。");
      const size = photoCanvasSize(photo.naturalWidth, photo.naturalHeight);
      canvas.width = size.width;
      canvas.height = size.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw Error("此瀏覽器不支援照片預覽。");
      ctx.fillStyle = "#edf4ed";
      ctx.fillRect(0, 0, size.width, size.height);
      ctx.drawImage(
        photo,
        (size.width - size.photoWidth) / 2,
        24,
        size.photoWidth,
        size.photoHeight,
      );
      const y = size.photoHeight + 58;
      ctx.fillStyle = "#126759";
      ctx.font = "bold 26px sans-serif";
      ctx.fillText(
        fitText(ctx, event.title.replace(/[\r\n]+/g, " "), size.width - 48),
        24,
        y,
      );
      ctx.font = "18px sans-serif";
      const day = new Intl.DateTimeFormat("zh-TW", {
        timeZone: "Asia/Taipei",
        dateStyle: "long",
      }).format(new Date(event.starts_at));
      ctx.fillText(day + " · 臺大癌醫小聚", 24, y + 32);
      ctx.fillStyle = "#62756d";
      ctx.font = "13px sans-serif";
      ctx.fillText("NTUCC MEETUP SPACES", 24, y + 59);
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/png"),
      );
      if (!active()) return;
      if (!blob) throw Error("無法產生 PNG，請重新選擇照片。");
      outputUrl = URL.createObjectURL(blob);
      download.href = outputUrl;
      download.hidden = false;
      canvas.hidden = false;
      status.textContent =
        "相框已完成。照片僅在此瀏覽器處理，未上傳；按下載儲存 PNG。";
    } catch (error) {
      if (active())
        status.textContent =
          error instanceof Error ? error.message : "無法讀取照片，請重新選擇。";
    }
  };
  return () => {
    disposed = true;
    generation++;
    releaseSource();
    releaseOutput();
    input.onchange = null;
    canvas.width = 0;
    canvas.height = 0;
    download.removeAttribute("href");
    input.value = "";
  };
}
