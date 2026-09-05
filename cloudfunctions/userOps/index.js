// userOps 云函数：微信登录（openid）+ 用户资料
const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const action = event.action || event.type;

  switch (action) {
    case "login":
      return login(OPENID, event);
    case "getUser":
      return getUser(OPENID);
    case "updateProfile":
      return updateProfile(OPENID, event);
    case "updateServiceNote":
      return updateServiceNote(OPENID, event);
    case "updateKimiKey":
      return updateKimiKey(OPENID, event);
    case "updateKimiModel":
      return updateKimiModel(OPENID, event);
    case "updateDeepSeekKey":
      return updateDeepSeekKey(OPENID, event);
    default:
      return { success: false, msg: "未知操作：" + action };
  }
};

// 登录：按 openid 查 users，不存在则创建
async function login(OPENID, event) {
  const { nickname, avatar } = event;
  const col = db.collection("users");
  const now = db.serverDate();

  try {
    const found = await col.where({ openid: OPENID }).get();
    if (found.data.length > 0) {
      const user = found.data[0];
      const data = { lastLoginTime: now };
      if (nickname) data.nickname = nickname;
      if (avatar) data.avatar = avatar;
      await col.doc(user._id).update({ data });
      const doc = await col.doc(user._id).get();
      return { success: true, user: doc.data };
    }

    const addRes = await col.add({
      data: {
        _openid: OPENID,
        openid: OPENID,
        nickname: nickname || "微信用户",
        avatar: avatar || "",
        kimiModel: "kimi-k2.6",
        createTime: now,
        lastLoginTime: now,
      },
    });
    const doc = await col.doc(addRes._id).get();
    return { success: true, user: doc.data };
  } catch (e) {
    console.error("login error", e);
    return { success: false, msg: e.errMsg || e.message };
  }
}

// 获取当前用户
async function getUser(OPENID) {
  try {
    const found = await db.collection("users").where({ openid: OPENID }).get();
    if (found.data.length > 0) {
      return { success: true, user: found.data[0] };
    }
    return { success: false, msg: "未登录" };
  } catch (e) {
    console.error("getUser error", e);
    return { success: false, msg: e.errMsg || e.message };
  }
}

// 更新资料
async function updateProfile(OPENID, event) {
  const { nickname, avatar } = event;
  try {
    const found = await db.collection("users").where({ openid: OPENID }).get();
    if (found.data.length === 0) {
      return { success: false, msg: "用户不存在，请先登录" };
    }
    const data = {};
    if (nickname != null) data.nickname = nickname;
    if (avatar != null) data.avatar = avatar;
    if (Object.keys(data).length > 0) {
      await db.collection("users").doc(found.data[0]._id).update({ data });
    }
    const doc = await db.collection("users").doc(found.data[0]._id).get();
    return { success: true, user: doc.data };
  } catch (e) {
    console.error("updateProfile error", e);
    return { success: false, msg: e.errMsg || e.message };
  }
}

// 更新服务说明（报表底部的提示语，按账户绑定）
async function updateServiceNote(OPENID, event) {
  const { serviceNote } = event;
  try {
    const found = await db.collection("users").where({ openid: OPENID }).get();
    if (found.data.length === 0) {
      return { success: false, msg: "用户不存在，请先登录" };
    }
    await db
      .collection("users")
      .doc(found.data[0]._id)
      .update({ data: { serviceNote: (serviceNote || "").trim() } });
    const doc = await db.collection("users").doc(found.data[0]._id).get();
    return { success: true, user: doc.data };
  } catch (e) {
    console.error("updateServiceNote error", e);
    return { success: false, msg: e.errMsg || e.message };
  }
}

// 更新 Kimi API Key（账户绑定，用于发票识别）
async function updateKimiKey(OPENID, event) {
  const { kimiApiKey } = event;
  try {
    const found = await db.collection("users").where({ openid: OPENID }).get();
    if (found.data.length === 0) {
      return { success: false, msg: "用户不存在，请先登录" };
    }
    await db
      .collection("users")
      .doc(found.data[0]._id)
      .update({ data: { kimiApiKey: (kimiApiKey || "").trim() } });
    const doc = await db.collection("users").doc(found.data[0]._id).get();
    return { success: true, user: doc.data };
  } catch (e) {
    console.error("updateKimiKey error", e);
    return { success: false, msg: e.errMsg || e.message };
  }
}

// 更新识别模型（账户绑定，发票识别用；与 API Key 独立设置）
// kimiModel 存当前识别模型，可为 Kimi 或 DeepSeek（前缀区分服务商）
const ALLOWED_MODELS = ["kimi-k2.6", "kimi-k3", "deepseek-v4-flash-vision-exp"];

async function updateKimiModel(OPENID, event) {
  const model = String(event.kimiModel || "").trim();
  if (!ALLOWED_MODELS.includes(model)) {
    return { success: false, msg: "不支持的模型：" + model };
  }
  try {
    const found = await db.collection("users").where({ openid: OPENID }).get();
    if (found.data.length === 0) {
      return { success: false, msg: "用户不存在，请先登录" };
    }
    await db
      .collection("users")
      .doc(found.data[0]._id)
      .update({ data: { kimiModel: model } });
    const doc = await db.collection("users").doc(found.data[0]._id).get();
    return { success: true, user: doc.data };
  } catch (e) {
    console.error("updateKimiModel error", e);
    return { success: false, msg: e.errMsg || e.message };
  }
}

// 更新 DeepSeek API Key（账户绑定，用于 DeepSeek 发票识别）
async function updateDeepSeekKey(OPENID, event) {
  const { deepseekApiKey } = event;
  try {
    const found = await db.collection("users").where({ openid: OPENID }).get();
    if (found.data.length === 0) {
      return { success: false, msg: "用户不存在，请先登录" };
    }
    await db
      .collection("users")
      .doc(found.data[0]._id)
      .update({ data: { deepseekApiKey: (deepseekApiKey || "").trim() } });
    const doc = await db.collection("users").doc(found.data[0]._id).get();
    return { success: true, user: doc.data };
  } catch (e) {
    console.error("updateDeepSeekKey error", e);
    return { success: false, msg: e.errMsg || e.message };
  }
}

