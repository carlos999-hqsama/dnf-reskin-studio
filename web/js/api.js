// api.js — 唯一网络出口。所有 fetch 都从这里走 (ARCHITECTURE.md §5.1)。
// 统一: 状态码检查 / 30s 超时 / json|blob / 错误归一成 ApiError。
// 兼容两种后端: 新服务(4xx + {error,code}) 和 旧服务(200 + {error}) 都优雅处理。

export class ApiError extends Error {
  constructor(message, code, status) {
    super(message || '未知错误');
    this.name = 'ApiError';
    this.code = code || null;
    this.status = status ?? null;
  }
}

const TIMEOUT_MS = 30000;

// 从响应里尽力抠出人话错误信息 (后端给 {error, code})。
async function readError(res) {
  let msg = '', code = null;
  try {
    const txt = await res.text();
    if (txt) {
      try {
        const j = JSON.parse(txt);
        msg = j.error || j.message || '';
        code = j.code || null;
      } catch {
        // 不是 JSON, 直接拿文本 (截断防超长)
        msg = txt.slice(0, 200);
      }
    }
  } catch { /* 读 body 也失败, 留空走默认 */ }
  return { msg, code };
}

/**
 * 统一请求。
 * @param {string} path 接口路径 (如 /api/open?...)
 * @param {object} opts
 * @param {string} [opts.method='GET']
 * @param {*}      [opts.body] 已是字符串则原样发, 否则 JSON.stringify
 * @param {'json'|'blob'} [opts.expect='json']
 * @param {AbortSignal} [opts.signal] 外部取消信号 (会与内置超时合并)
 * @returns {Promise<any|string>} expect:'json'→对象; expect:'blob'→objectURL 字符串
 * @throws {ApiError}
 */
export async function request(path, opts = {}) {
  const { method = 'GET', body, expect = 'json', signal, timeout = TIMEOUT_MS } = opts;

  // 内置超时(可 per-call 覆盖: 打包/部署/隐藏这类慢操作要放长, 否则 30s 误报"服务无响应")+ 合并外部 signal。
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  let timedOut = false;
  // timeout<=0 → 不自动超时(慢操作时间因机器而异, 交给用户取消按钮 / 刷新页面自动中断, 不由前端写死)。
  const timer = timeout > 0 ? setTimeout(() => { timedOut = true; ctrl.abort(); }, timeout) : null;

  const init = { method, signal: ctrl.signal };
  if (body !== undefined && body !== null) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    init.headers = { 'Content-Type': 'application/json' };
  }

  let res;
  try {
    res = await fetch(path, init);
  } catch (e) {
    // fetch reject: 超时 vs 真网络断 vs 外部取消
    if (timedOut) throw new ApiError('服务无响应 (超时)', 'timeout', null);
    if (signal && signal.aborted) throw new ApiError('已取消', 'aborted', null);
    throw new ApiError('连不上服务', 'network', null);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }

  // 兼容旧后端: 即便 HTTP 200, 若 Content-Type 是 JSON 且带 error 字段也当失败。
  const ctype = (res.headers.get('Content-Type') || '').toLowerCase();
  const looksJson = ctype.includes('application/json') || ctype.includes('text/json');

  if (!res.ok) {
    const { msg, code } = await readError(res);
    throw new ApiError(msg || `请求失败 (HTTP ${res.status})`, code, res.status);
  }

  if (expect === 'blob') {
    // 二进制接口: 旧后端"假成功"会回 200+JSON 错误体 → 当错误处理, 别当图片。
    if (looksJson) {
      const { msg, code } = await readError(res);
      throw new ApiError(msg || '服务返回了错误而非图片', code, res.status);
    }
    const blob = await res.blob();
    if (!blob || blob.size === 0) throw new ApiError('服务返回空图片', 'empty', res.status);
    return URL.createObjectURL(blob);
  }

  // expect json
  if (!looksJson) {
    // 期望 JSON 却拿到别的 (如 HTML 错误页)
    const txt = await res.text().catch(() => '');
    throw new ApiError(txt ? txt.slice(0, 200) : '服务返回了非预期内容', 'bad_content_type', res.status);
  }
  let data;
  try {
    data = await res.json();
  } catch {
    throw new ApiError('服务返回了无法解析的内容', 'bad_json', res.status);
  }
  // 旧后端假成功兜底: 200 + {error}
  if (data && typeof data === 'object' && data.error && data.ok !== true) {
    throw new ApiError(data.error, data.code || null, res.status);
  }
  return data;
}
