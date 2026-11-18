type Request = (
  path: string,
  method?: string,
  body?: unknown,
) => Promise<Response>;
type Photo = {
  id: string;
  event_id?: string;
  caption?: string;
  status: string;
  width: number;
  height: number;
  created_at: string;
  is_owner?: boolean;
  publication_consent?: boolean;
  audience?: string;
  review_reason?: string;
  storage_deleted?: boolean;
};
export function photoListPath(
  eventId: string | null,
  page: number,
  mineOnly = false,
) {
  const params = new URLSearchParams({ page: String(page) });
  if (eventId) params.set("event_id", eventId);
  if (!eventId || mineOnly) params.set("scope", "mine");
  return "?" + params.toString();
}
/** Explicit, authenticated private submission, separate from the local-only frame tool. */
export function mountPhotoSubmissions(
  host: HTMLElement,
  eventId: string | null,
  request: Request,
  active: () => boolean,
  options: { manageOnly?: boolean; mineOnly?: boolean } = {},
) {
  let disposed = false;
  let listGeneration = 0;
  let page = 1;
  const urls = new Set<string>();
  const alive = () => !disposed && active();
  const release = () => {
    for (const url of urls) URL.revokeObjectURL(url);
    urls.clear();
  };
  host.innerHTML =
    '<h2>手動提交照片（私有待審）</h2><p>下方是獨立上傳功能，不會自動取得上方本機照片。僅已完成有效報名者可提交。請自行選擇要傳送的 PNG；上傳後只有本人與管理員可查看，不公開，也不代表你同意未來公開。</p><form class="public-editor"><label>PNG 檔案（最多 1 MB，長邊最多 1600）<input name="photo" type="file" accept="image/png" required></label><p>需為非交錯、8-bit RGB/RGBA PNG。本機相框下載可能超過 1 MB，請先縮小或重新輸出，不能直接提交超限檔案。</p><label>照片說明（選填）<input name="caption" maxlength="500"></label><label class="check"><input name="consent" type="checkbox" required>我有權使用此照片，已取得入鏡者同意，並同意將此照片提交主辦方私有待審；不包含公開發布授權。</label><button type="submit">確認上傳至私有待審</button></form><p class="photo-submit-status" role="status" aria-live="polite"></p><h2>我的照片</h2><p>管理員可查看本活動所有提交照片；其他帳號僅能查看自己的照片。</p><div class="photo-submissions-list"></div>';
  const mineOnly = !eventId || options.mineOnly === true;
  if (!eventId || options.manageOnly)
    host.innerHTML =
      '<h2>我的照片</h2><p>僅顯示自己的照片，可撤回公開授權及刪除，不需讀取活動內容。此頁不提供上傳。</p><p class="photo-submit-status" role="status" aria-live="polite"></p><div class="photo-submissions-list"></div>';
  const form = host.querySelector<HTMLFormElement>("form");
  const status = host.querySelector<HTMLElement>(".photo-submit-status")!;
  const list = host.querySelector<HTMLElement>(".photo-submissions-list")!;
  const fail = (error: unknown) => {
    if (alive())
      status.textContent =
        error instanceof Error ? error.message : "操作失敗，請重試。";
  };
  async function load() {
    const current = ++listGeneration;
    release();
    list.textContent = "正在載入照片清單…";
    try {
      const result = await (
        await request(photoListPath(eventId, page, mineOnly))
      ).json();
      if (!alive() || current !== listGeneration) return;
      list.replaceChildren();
      if (!result.photos.length) list.textContent = "本頁尚無照片。";
      for (const photo of (result.photos as Photo[]).filter(
        (photo) => !mineOnly || photo.is_owner,
      )) {
        const article = document.createElement("article");
        article.className = "public-announcement";
        const description = document.createElement("p");
        description.textContent = `${photo.caption || "未填說明"} · ${photo.status === "pending" ? "私有待審" : photo.status} · ${photo.width} × ${photo.height}${!eventId && photo.event_id ? ` · 活動識別碼 ${photo.event_id}` : ""}`;
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = "載入私有照片預覽";
        button.onclick = async () => {
          if (button.disabled) return;
          button.disabled = true;
          try {
            const blob = await (
              await request("/" + encodeURIComponent(photo.id))
            ).blob();
            if (!alive() || current !== listGeneration) return;
            if (blob.type !== "image/png") throw Error("無法預覽非 PNG 回應。");
            const url = URL.createObjectURL(blob);
            urls.add(url);
            const image = document.createElement("img");
            image.src = url;
            image.alt = photo.caption || "私有待審照片";
            image.className = "public-photo-preview";
            article.append(image);
            button.remove();
          } catch (error) {
            fail(error);
            if (button.isConnected) button.disabled = false;
          }
        };
        let previewLoaded = false;
        const originalPreview = button.onclick;
        // Publication review requires opening the actual image, not just its caption.
        button.onclick = async (event) => {
          await originalPreview?.call(button, event);
          previewLoaded = !button.isConnected;
        };
        article.append(description);
        if (photo.status !== "withdrawn" && !photo.storage_deleted)
          article.append(button);
        const info = document.createElement("p");
        info.textContent = `公開授權：${photo.publication_consent && photo.audience === "public_web" ? "已同意全網公開" : "未授權公開"}${photo.review_reason ? `；退回原因：${photo.review_reason}` : ""}${photo.status === "withdrawn" ? (photo.storage_deleted ? "；儲存檔案已刪除" : "；已撤回，儲存檔案仍待清理") : ""}`;
        article.append(info);
        const checkbox = (label: string) => {
          const holder = document.createElement("label");
          holder.className = "public-photo-confirm";
          const input = document.createElement("input");
          input.type = "checkbox";
          holder.append(input, document.createTextNode(label));
          article.append(holder);
          return input;
        };
        let busy = false;
        const operation = (label: string, fn: () => Promise<void>) => {
          const control = document.createElement("button");
          control.type = "button";
          control.textContent = label;
          control.onclick = async () => {
            if (busy || !alive() || current !== listGeneration) return;
            busy = true;
            const controls = Array.from(
              article.querySelectorAll<HTMLButtonElement>("button"),
            );
            controls.forEach((b) => (b.disabled = true));
            try {
              await fn();
            } catch (error) {
              fail(error);
            } finally {
              busy = false;
              controls.forEach((b) => {
                if (b.isConnected) b.disabled = false;
              });
            }
          };
          article.append(control);
        };
        const photoPath = "/" + encodeURIComponent(photo.id);
        if (photo.is_owner) {
          if (photo.status !== "withdrawn") {
            if (!photo.publication_consent) {
              const consent = checkbox(
                "我另行同意此照片經人工審查後，向全網所有訪客公開（public_web），並已取得入鏡者的公開使用同意。公開後既有下載或轉存副本無法追回。",
              );
              operation("確認授予全網公開授權", async () => {
                if (!consent.checked)
                  throw Error("請先閱讀並勾選獨立的全網公開授權。");
                await request(photoPath, "PATCH", {
                  publication_consent: true,
                  audience: "public_web",
                });
                if (alive()) {
                  status.textContent =
                    "已記錄公開授權，仍需管理員人工審查後才會公開。";
                  await load();
                }
              });
            } else
              operation("撤回公開授權並下架", async () => {
                await request(photoPath, "PATCH", {
                  publication_consent: false,
                  audience: "public_web",
                });
                if (alive()) {
                  status.textContent = "已撤回公開授權；既有下載副本無法追回。";
                  await load();
                }
              });
          }
          if (!photo.storage_deleted) {
            const deletion = checkbox(
              "我確認撤回並刪除此照片；必要操作紀錄仍保留，既有公開下載副本無法追回。",
            );
            operation(
              photo.status === "withdrawn"
                ? "重試刪除儲存檔案"
                : "撤回並刪除照片",
              async () => {
                if (!deletion.checked) throw Error("請先確認撤回與刪除。");
                const result = await (
                  await request(photoPath, "DELETE")
                ).json();
                if (alive()) {
                  status.textContent = result.storage_deleted
                    ? "照片已撤回，儲存檔案已刪除；必要操作紀錄仍保留，既有下載副本無法追回。"
                    : "照片已撤回，但儲存檔案尚未刪除，需重試清理。";
                  await load();
                }
              },
            );
          }
        }
        if (
          result.is_admin &&
          photo.status !== "withdrawn" &&
          !photo.storage_deleted
        ) {
          const reviewed = checkbox(
            "我已逐張查看實際照片，人工檢查個資、病歷內容、肖像與使用權利；系統不會自動辨識病歷照片。",
          );
          const reasonLabel = document.createElement("label");
          reasonLabel.textContent = "審查／退回原因";
          const reason = document.createElement("textarea");
          reason.maxLength = 1000;
          reasonLabel.append(reason);
          article.append(reasonLabel);
          for (const decision of ["publish", "return"] as const)
            operation(
              decision === "publish"
                ? "人工審查通過並公開"
                : "退回私有並記錄原因",
              async () => {
                if (!previewLoaded || !reviewed.checked)
                  throw Error("請先載入並逐張查看照片，再勾選人工檢查確認。");
                if (
                  decision === "publish" &&
                  (!photo.publication_consent ||
                    photo.audience !== "public_web")
                )
                  throw Error("本人尚未授予全網公開授權，不能發布。");
                if (decision === "return" && !reason.value.trim())
                  throw Error("請填寫退回原因。");
                await request(photoPath, "PATCH", {
                  decision,
                  reason: reason.value.trim(),
                  reviewed_for_publication: true,
                  ...(decision === "publish" ? { audience: "public_web" } : {}),
                });
                if (alive()) {
                  status.textContent =
                    decision === "publish"
                      ? "照片已發布至公開相簿。"
                      : "照片已退回私有，已記錄原因。";
                  await load();
                }
              },
            );
        }
        list.append(article);
      }
      if (!mineOnly && result.is_admin) {
        const cleanup = document.createElement("button");
        cleanup.type = "button";
        cleanup.textContent = "重試清理已撤回照片（最多 25 筆）";
        cleanup.onclick = async () => {
          if (cleanup.disabled) return;
          cleanup.disabled = true;
          try {
            const result = await (await request("/cleanup", "POST", {})).json();
            if (alive()) {
              status.textContent = `已處理 ${result.processed} 筆，已刪除 ${result.deleted} 筆，仍待清理 ${result.pending} 筆。`;
              await load();
            }
          } catch (error) {
            fail(error);
            if (cleanup.isConnected) cleanup.disabled = false;
          }
        };
        list.append(cleanup);
      }
      const navigation = document.createElement("nav");
      navigation.className = "public-roster-pages";
      const label = document.createElement("span");
      label.textContent = `第 ${page} 頁`;
      for (const delta of [-1, 1]) {
        if (
          (delta < 0 && page === 1) ||
          (delta > 0 && result.photos.length < result.page_size)
        )
          continue;
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = delta < 0 ? "上一頁" : "下一頁";
        button.onclick = () => {
          page += delta;
          void load();
        };
        navigation.append(button);
      }
      navigation.append(label);
      list.append(navigation);
    } catch (error) {
      if (!alive() || current !== listGeneration) return;
      list.textContent = "照片清單載入失敗。";
      fail(error);
      const retry = document.createElement("button");
      retry.textContent = "重試清單";
      retry.onclick = () => void load();
      list.append(retry);
    }
  }
  if (form)
    form.onsubmit = async (event) => {
      event.preventDefault();
      const button = form.querySelector<HTMLButtonElement>("button")!;
      if (button.disabled || !form.reportValidity()) return;
      button.disabled = true;
      status.textContent = "";
      try {
        const file =
          form.querySelector<HTMLInputElement>('[name="photo"]')!.files?.[0];
        if (
          !file ||
          file.type !== "image/png" ||
          !file.size ||
          file.size > 1_000_000
        )
          throw Error("請選擇不超過 1 MB 的 PNG；相框檔案過大時請先縮小。");
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (!alive()) return;
        // Validate basic PNG/IHDR bounds locally. The server performs complete PNG validation.
        const signature = [137, 80, 78, 71, 13, 10, 26, 10];
        const view = new DataView(bytes.buffer);
        if (
          bytes.length < 33 ||
          !signature.every((v, i) => bytes[i] === v) ||
          view.getUint32(8) !== 13 ||
          view.getUint32(12) !== 0x49484452 ||
          !view.getUint32(16) ||
          !view.getUint32(20) ||
          Math.max(view.getUint32(16), view.getUint32(20)) > 1600 ||
          bytes[24] !== 8 ||
          ![2, 6].includes(bytes[25]) ||
          bytes[28] !== 0
        )
          throw Error(
            "PNG 格式不符：需長邊最多 1600、非交錯、8-bit RGB/RGBA，請重新輸出。",
          );
        let binary = "";
        for (let i = 0; i < bytes.length; i += 8192)
          binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        await request("", "POST", {
          event_id: eventId,
          png_base64: btoa(binary),
          caption: form
            .querySelector<HTMLInputElement>('[name="caption"]')!
            .value.trim(),
          consent: true,
        });
        if (!alive()) return;
        form.reset();
        status.textContent = "已提交私有待審，未公開。";
        page = 1;
        await load();
      } catch (error) {
        fail(error);
      } finally {
        if (button.isConnected) button.disabled = false;
      }
    };
  void load();
  return () => {
    disposed = true;
    listGeneration++;
    release();
    if (form) {
      form.onsubmit = null;
      form.reset();
    }
    list.replaceChildren();
  };
}

/** Public gallery only calls the server's public, no-store proxy. */
export function mountPublicPhotoGallery(
  host: HTMLElement,
  eventId: string,
  active: () => boolean,
) {
  let disposed = false,
    generation = 0,
    page = 1;
  const urls = new Set<string>();
  const clear = () => {
    for (const url of urls) URL.revokeObjectURL(url);
    urls.clear();
  };
  const alive = (current: number) =>
    !disposed && active() && current === generation;
  async function load() {
    const current = ++generation;
    clear();
    host.innerHTML = '<h2>公開活動相簿</h2><p role="status">正在載入…</p>';
    try {
      const response = await fetch(
        `/api/v1/event-photos/public?event_id=${encodeURIComponent(eventId)}&page=${page}`,
        { cache: "no-store", credentials: "omit" },
      );
      if (!response.ok) throw Error("公開相簿目前無法載入。");
      const result = await response.json();
      if (!alive(current)) return;
      host.innerHTML =
        "<h2>公開活動相簿</h2><p>僅顯示已獲本人全網公開授權且經管理員人工審查發布的照片。</p>";
      if (!result.photos.length) {
        const empty = document.createElement("p");
        empty.textContent = "本頁尚無公開照片。";
        host.append(empty);
      }
      for (const photo of result.photos as Photo[]) {
        const figure = document.createElement("figure");
        const caption = document.createElement("figcaption");
        caption.textContent = photo.caption || "活動照片";
        const button = document.createElement("button");
        button.textContent = "查看公開照片";
        button.onclick = async () => {
          if (button.disabled) return;
          button.disabled = true;
          try {
            const response = await fetch(
              `/api/v1/event-photos/public/${encodeURIComponent(photo.id)}`,
              { cache: "no-store", credentials: "omit" },
            );
            if (!response.ok) throw Error("照片已撤下或暫時無法載入。");
            const blob = await response.blob();
            if (!alive(current)) return;
            if (blob.type !== "image/png") throw Error("無法顯示照片。");
            const url = URL.createObjectURL(blob);
            urls.add(url);
            const image = document.createElement("img");
            image.src = url;
            image.alt = photo.caption || "公開活動照片";
            image.className = "public-photo-preview";
            figure.append(image);
            button.remove();
          } catch (error) {
            if (alive(current)) {
              button.textContent =
                error instanceof Error
                  ? error.message + " 點此重試"
                  : "載入失敗，重試";
              button.disabled = false;
            }
          }
        };
        figure.append(caption, button);
        host.append(figure);
      }
      const nav = document.createElement("nav");
      nav.className = "public-roster-pages";
      for (const delta of [-1, 1]) {
        if (
          (delta < 0 && page === 1) ||
          (delta > 0 && result.photos.length < result.page_size)
        )
          continue;
        const button = document.createElement("button");
        button.textContent = delta < 0 ? "上一頁" : "下一頁";
        button.onclick = () => {
          page += delta;
          void load();
        };
        nav.append(button);
      }
      const refresh = document.createElement("button");
      refresh.textContent = "重新整理相簿";
      refresh.onclick = () => void load();
      nav.append(refresh);
      host.append(nav);
    } catch (error) {
      if (alive(current)) {
        host.textContent =
          error instanceof Error ? error.message : "無法載入相簿";
        const retry = document.createElement("button");
        retry.textContent = "重試相簿";
        retry.onclick = () => void load();
        host.append(retry);
      }
    }
  }
  void load();
  return () => {
    disposed = true;
    generation++;
    clear();
    host.replaceChildren();
  };
}
