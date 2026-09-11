// invoiceOCR 云函数：上传的发票图片 → 调 Kimi 视觉模型识别成结构化明细
const cloud = require("wx-server-sdk");
const https = require("https");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 默认识别模型：Kimi K2.6（支持图片，输出价约 K3 的 1/4，可关思考）
// 模型以 users.kimiModel 为「当前识别模型」，可为 Kimi 或 DeepSeek（按前缀区分服务商）
// API Key 与请求地址按服务商分别存：kimiApiKey / deepseekApiKey + deepseekBaseUrl
// 模型优先取用户选择的（users.kimiModel），回退环境变量 KIMI_MODEL，再回退默认
const DEFAULT_MODEL = "kimi-k2.6";
// DeepSeek 调用名：deepseek-flash（V4.1 Flash，2026-09-10 GA，原生多模态视觉）
const ALLOWED_MODELS = ["kimi-k2.6", "kimi-k3", "deepseek-flash"];
const KIMI_URL = "https://api.moonshot.cn/v1/chat/completions";
const DEEPSEEK_DEFAULT_URL = "https://api.deepseek.com/v1/chat/completions";

function isDeepSeek(model) {
  return /^deepseek/i.test(String(model || ""));
}

// 读取一次当前账户
async function getUserOnce(OPENID) {
  try {
    const found = await db.collection("users").where({ openid: OPENID }).get();
    return found.data.length > 0 ? found.data[0] : null;
  } catch (e) {
    console.error("getUserOnce error", e);
    return null;
  }
}

// 获取当前账户的识别设置：按模型确定服务商的 apiKey 与请求端点
async function getUserSettings(OPENID) {
  const envModel = process.env.KIMI_MODEL || DEFAULT_MODEL;
  let model = ALLOWED_MODELS.includes(envModel) ? envModel : DEFAULT_MODEL;
  const user = await getUserOnce(OPENID);
  if (user && user.kimiModel && ALLOWED_MODELS.includes(user.kimiModel)) model = user.kimiModel;

  let apiKey = "";
  let url = "";
  if (isDeepSeek(model)) {
    url =
      (user && user.deepseekBaseUrl && user.deepseekBaseUrl.trim()) ||
      process.env.DEEPSEEK_API_URL ||
      DEEPSEEK_DEFAULT_URL;
    apiKey = (user && user.deepseekApiKey && user.deepseekApiKey.trim()) || process.env.DEEPSEEK_API_KEY || "";
  } else {
    url = KIMI_URL;
    apiKey = (user && user.kimiApiKey) || process.env.KIMI_API_KEY || "";
  }
  return { apiKey, model, url };
}

const PROMPT = `你是发票/送货单识别助手。识别图片后，只输出一个 JSON 对象，禁止输出任何其他文字、解释、markdown 或思考过程，也不要给 JSON 加注释：
{
  "title": "单据标题",
  "supplier": "供应商/开票方名称，识别不到就填空字符串",
  "date": "单据日期，格式YYYY-MM-DD，识别不到就填空字符串",
  "items": [
    {"name":"商品名称","unit":"单位","quantity":2,"price":100,"amount":200}
  ]
}
规则：
1. 逐行提取每个商品明细：name 名称、unit 单位、quantity 数量、price 单价、amount 金额。
2. 数量/单价/金额必须是数字，识别不到填 0，不要杜撰。
3. 若只有数量和金额没有单价，用 amount/quantity 推算单价（保留两位）；只有单价没有金额则 amount=price*quantity。
4. items 必须是一个数组，哪怕只有一行也放进数组。
5. 最终回复必须从 { 开始、以 } 结束，中间是合法 JSON。`;

function callChat(url, base64Image, mime, apiKey, model) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: PROMPT },
            {
              type: "image_url",
              image_url: { url: `data:${mime};base64,${base64Image}` },
            },
          ],
        },
      ],
      // K2.x 用 thinking.disabled 关思考：省输出 token（省钱）且输出更稳定；
      // K2.x 温度/top_p 固定（1/0.95），不可自定义。K3 强制思考，不传该参数。
      ...(model.includes("k2") ? { thinking: { type: "disabled" } } : {}),
      response_format: { type: "json_object" },
    });

    const u = new URL(url);
    const options = {
      hostname: u.hostname,
      port: u.port || undefined,
      path: (u.pathname || "/") + (u.search || ""),
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + apiKey,
        "Content-Length": Buffer.byteLength(payload),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(data));
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function normalizeItem(it) {
  const price = Number(it.price) || 0;
  const quantity = Number(it.quantity) || 0;
  let amount = Number(it.amount) || 0;
  if (!amount && price && quantity) {
    amount = Math.round(price * quantity * 100) / 100;
  }
  if (!price && amount && quantity) {
    price = Math.round((amount / quantity) * 100) / 100;
  }
  return {
    name: String(it.name || "").trim(),
    unit: String(it.unit || "").trim() || "个",
    quantity,
    price,
    amount,
  };
}

// 将 Kimi 返回的 content 解析成对象（多级兜底，容忍思考文本/包裹）
function parseContent(content) {
  const str = String(content || "");
  // 1) 整体解析
  try {
    const r = JSON.parse(str);
    if (r && typeof r === "object") return r;
  } catch (e) {}

  // 2) 单独提取 items 数组
  const mItems = str.match(/"items"\s*:\s*(\[[\s\S]*?\])/);
  if (mItems) {
    try {
      const items = JSON.parse(mItems[1]);
      return { items };
    } catch (e) {}
  }

  // 3) 提取任意 JSON 对象
  const mObj = str.match(/\{[\s\S]*\}/);
  if (mObj) {
    try {
      const r = JSON.parse(mObj[0]);
      if (r && typeof r === "object") return r;
    } catch (e) {}
  }

  return {};
}

exports.main = async (event) => {
  const action = event.action || event.type;
  if (action === "recognize") {
    const { fileID, mimeType } = event;
    const { OPENID } = cloud.getWXContext();
    if (!fileID) return { success: false, msg: "缺少文件" };
    const { apiKey, model, url } = await getUserSettings(OPENID);
    if (!apiKey) {
      return {
        success: false,
        msg: isDeepSeek(model)
          ? "未配置 DeepSeek API Key，请在小程序「我的」页填写"
          : "未配置 Kimi API Key，请在小程序「我的」页填写",
      };
    }
    try {
      const dl = await cloud.downloadFile({ fileID });
      const buffer = dl.fileContent;
      const mime = mimeType || "image/jpeg";
      const raw = await callChat(url, buffer.toString("base64"), mime, apiKey, model);

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        parsed = null;
      }
      const content =
        parsed &&
        parsed.choices &&
        parsed.choices[0] &&
        parsed.choices[0].message &&
        parsed.choices[0].message.content;

      if (!content) {
        console.error("识别服务返回异常:", raw.slice(0, 500));
        return { success: false, msg: "识别服务返回异常，请检查 API key / 模型名 / 服务地址" };
      }

      // content 解析成对象（多级兜底）
      let result = parseContent(content);

      const items = Array.isArray(result.items)
        ? result.items.map(normalizeItem).filter((it) => it.name)
        : [];

      if (!items.length) {
        console.error("识别明细为空, content:", String(content).slice(0, 500));
      }

      return {
        success: true,
        items,
        title: result.title || "",
        supplier: result.supplier || "",
        date: result.date || "",
        model, // 实际使用的识别模型，供确认页标注「这张图是哪个模型识别的」
      };
    } catch (e) {
      console.error("recognize error", e);
      return { success: false, msg: (e && e.message) || "识别失败" };
    }
  }
  return { success: false, msg: "未知操作" };
};
