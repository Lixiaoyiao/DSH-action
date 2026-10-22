/* global location, history, sessionStorage, fetch, URLSearchParams */
const storageKey = "dsh-installer-token";
const fragment = new URLSearchParams(location.hash.slice(1));
const incoming = fragment.get("token");
if (incoming) {
  sessionStorage.setItem(storageKey, incoming);
  history.replaceState(null, "", `${location.pathname}${location.search}`);
}
const token = incoming || sessionStorage.getItem(storageKey);

export async function request(path, body) {
  if (!token) throw new Error("本地连接凭据缺失。请从终端重新打开配置工具提供的链接。");
  const response = await fetch(`/api/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    credentials: "omit",
    cache: "no-store",
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `本地请求失败（${response.status}）`);
  return result;
}
