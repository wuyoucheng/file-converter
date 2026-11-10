/**
 * FormatFlow 代理 Worker
 * ---------------------------------------------------------------
 * 作用：把 CloudConvert 和 MinerU 的密钥留在服务端，并绕开浏览器
 * 直连 OSS / CDN 时的跨域限制。浏览器只需要和这个 Worker 通信。
 *
 * 部署（推荐 wrangler）：
 *   cd worker
 *   npx wrangler secret put CLOUDCONVERT_API_KEY
 *   npx wrangler secret put MINERU_API_TOKEN
 *   npx wrangler deploy
 *
 * 或者在 Cloudflare Dashboard → Workers & Pages → 新建 Worker，
 * 粘贴本文件，然后在 Settings → Variables 里加两个 Secret。
 *
 * 注意：MinerU token 有效期 14 天，过期后到
 * https://mineru.net/apiManage/token 重新生成并更新 Secret，
 * 不需要重新部署 Worker。
 */

const CLOUDCONVERT_API = 'https://api.cloudconvert.com/v2';
const MINERU_API = 'https://mineru.net/api/v4';

// 只允许代理这些域名（按后缀匹配），否则这个 Worker 会变成任意请求的开放代理（SSRF）。
// MinerU 的预签名上传地址在阿里云 OSS 上、结果包在 openxlab CDN 上，域名不固定，
// 所以按后缀放行；内网地址和 169.254 元数据接口天然落在名单之外。
const ALLOWED_HOST_SUFFIXES = [
    'mineru.net',
    'api.cloudconvert.com',
    'cloudconvert.com',
    'aliyuncs.com',
    'openxlab.org.cn',
];

function isAllowedHost(hostname) {
    return ALLOWED_HOST_SUFFIXES.some(
        suffix => hostname === suffix || hostname.endsWith('.' + suffix)
    );
}

function corsHeaders(extra = {}) {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        ...extra,
    };
}

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: corsHeaders({ 'Content-Type': 'application/json' }),
    });
}

/** 校验代理目标地址，防止被当作开放代理滥用 */
function checkTarget(rawTarget) {
    if (!rawTarget) return { error: 'missing target' };
    let parsed;
    try {
        parsed = new URL(rawTarget);
    } catch {
        return { error: 'malformed target' };
    }
    if (parsed.protocol !== 'https:') return { error: 'only https allowed' };
    if (!isAllowedHost(parsed.hostname)) {
        return { error: 'host not allowed: ' + parsed.hostname };
    }
    return { url: parsed.toString() };
}

export default {
    async fetch(request, env) {
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: corsHeaders() });
        }

        const url = new URL(request.url);
        const path = url.pathname;

        try {
            // 自检：告诉前端这个 Worker 配好了哪些上游密钥（不泄露密钥本身）
            if (path === '/health' && request.method === 'GET') {
                return json({
                    ok: true,
                    cloudconvert: Boolean(env.CLOUDCONVERT_API_KEY),
                    mineru: Boolean(env.MINERU_API_TOKEN),
                });
            }

            /* ==========================================================
             * CloudConvert —— 沿用原有 /jobs 路径
             * ======================================================== */

            if (path === '/jobs' && request.method === 'POST') {
                if (!env.CLOUDCONVERT_API_KEY) return json({ error: 'CLOUDCONVERT_API_KEY not configured' }, 500);

                const upstream = await fetch(`${CLOUDCONVERT_API}/jobs`, {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${env.CLOUDCONVERT_API_KEY}`,
                        'Content-Type': 'application/json',
                    },
                    body: await request.text(),
                });
                return json(await upstream.json(), upstream.status);
            }

            const ccJobMatch = path.match(/^\/jobs\/([^/]+)$/);
            if (ccJobMatch && request.method === 'GET') {
                if (!env.CLOUDCONVERT_API_KEY) return json({ error: 'CLOUDCONVERT_API_KEY not configured' }, 500);

                const upstream = await fetch(`${CLOUDCONVERT_API}/jobs/${ccJobMatch[1]}`, {
                    headers: { Authorization: `Bearer ${env.CLOUDCONVERT_API_KEY}` },
                });
                return json(await upstream.json(), upstream.status);
            }

            /* ==========================================================
             * MinerU 精准解析 API v4
             * ======================================================== */

            // 1) 申请上传地址：返回 batch_id + 预签名 file_urls
            if (path === '/mineru/file-urls/batch' && request.method === 'POST') {
                if (!env.MINERU_API_TOKEN) return json({ error: 'MINERU_API_TOKEN not configured' }, 500);

                const upstream = await fetch(`${MINERU_API}/file-urls/batch`, {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${env.MINERU_API_TOKEN}`,
                        'Content-Type': 'application/json',
                    },
                    body: await request.text(),
                });
                return json(await upstream.json(), upstream.status);
            }

            // 2) 把文件流转到 OSS 预签名地址（浏览器直连会被 CORS 拦）
            if (path === '/mineru/upload' && request.method === 'PUT') {
                const target = checkTarget(url.searchParams.get('target'));
                if (target.error) return json({ error: target.error }, 400);

                const upstream = await fetch(target.url, {
                    method: 'PUT',
                    body: await request.arrayBuffer(),
                    // 关键：不能带 Content-Type。OSS 的签名是按无 Content-Type
                    // 计算的，加了会 SignatureDoesNotMatch。
                    headers: {},
                });

                if (!upstream.ok) {
                    return json({ error: 'upload rejected', status: upstream.status, detail: await upstream.text() }, upstream.status);
                }
                return json({ ok: true });
            }

            // 3) 轮询批次结果
            const batchMatch = path.match(/^\/mineru\/extract-results\/batch\/([^/]+)$/);
            if (batchMatch && request.method === 'GET') {
                if (!env.MINERU_API_TOKEN) return json({ error: 'MINERU_API_TOKEN not configured' }, 500);

                const upstream = await fetch(`${MINERU_API}/extract-results/batch/${batchMatch[1]}`, {
                    headers: { Authorization: `Bearer ${env.MINERU_API_TOKEN}` },
                });
                return json(await upstream.json(), upstream.status);
            }

            // 4) 下载结果 zip（CDN 地址，浏览器直连同样会被 CORS 拦）
            if (path === '/mineru/download' && request.method === 'GET') {
                const target = checkTarget(url.searchParams.get('target'));
                if (target.error) return json({ error: target.error }, 400);

                const upstream = await fetch(target.url);
                if (!upstream.ok) return json({ error: 'download failed', status: upstream.status }, upstream.status);

                return new Response(upstream.body, {
                    headers: corsHeaders({
                        'Content-Type': upstream.headers.get('Content-Type') || 'application/zip',
                    }),
                });
            }

            return json({ error: 'Not found', path }, 404);
        } catch (e) {
            return json({ error: e.message }, 500);
        }
    },
};
