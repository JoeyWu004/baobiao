// reportOps 云函数：报表事务保存 + 价格历史查询
const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 金额四舍五入到两位小数
function roundMoney(n) {
  return Math.round(Number(n) * 100) / 100;
}

// 商品某单位的售价（兼容无 units 的旧数据）
function unitSellPrice(product, unit) {
  if (Array.isArray(product.units) && product.units.length) {
    const u = product.units.find((x) => x.name === unit) || product.units[0];
    return Number(u.sellPrice) || 0;
  }
  return Number(product.sellPrice) || 0;
}

// 构造（或复用）units 数组
function ensureUnits(product) {
  if (Array.isArray(product.units) && product.units.length) {
    return product.units.slice();
  }
  return [
    {
      name: product.unit || "个",
      costPrice: product.costPrice || 0,
      sellPrice: product.sellPrice || 0,
      quantity: product.quantity || 0,
    },
  ];
}

// 更新某单位售价；返回 { units, changedDefault }（默认单位时需同步顶层字段）
function updateUnitSellPrice(product, unit, newPrice) {
  const units = ensureUnits(product);
  const idx = units.findIndex((u) => u.name === unit);
  if (idx >= 0) units[idx] = { ...units[idx], sellPrice: newPrice };
  else units.push({ name: unit, costPrice: 0, sellPrice: newPrice, quantity: 0 });
  return { units, changedDefault: units[0].name === unit };
}

// 更新某单位库存；返回 { units, changedDefault }
function updateUnitQuantity(product, unit, newQty) {
  const units = ensureUnits(product);
  const idx = units.findIndex((u) => u.name === unit);
  if (idx >= 0) units[idx] = { ...units[idx], quantity: newQty };
  else units.push({ name: unit, costPrice: 0, sellPrice: 0, quantity: newQty });
  return { units, changedDefault: units[0].name === unit };
}

// 默认服务说明（账户未设置时使用）
const DEFAULT_NOTE = "";

// 获取当前账户的服务说明
async function getUserNote(OPENID) {
  try {
    const found = await db.collection("users").where({ openid: OPENID }).get();
    if (found.data.length > 0 && found.data[0].serviceNote) {
      return found.data[0].serviceNote;
    }
  } catch (e) {
    console.error("getUserNote error", e);
  }
  return DEFAULT_NOTE;
}

// 调整商品某单位库存并记录数量变动（报表消耗/回补）
async function applyStockDelta(t, OPENID, productId, unit, delta, reportId) {
  if (!productId || !delta) return;
  try {
    const doc = await t.collection("products").doc(productId).get();
    const p = doc.data;
    if (!p) return;
    const uName = (unit || "").trim() || p.unit || "个";
    const curQty = unitQuantity(p, uName);
    const after = roundMoney(curQty + delta); // 库存允许为负
    const upd = updateUnitQuantity(p, uName, after);
    const updateData = { units: upd.units, updateTime: db.serverDate() };
    if (upd.changedDefault) updateData.quantity = after;
    await t.collection("products").doc(productId).update({ data: updateData });
    await t.collection("quantityHistory").add({
      data: {
        _openid: OPENID,
        productId,
        productName: p.name,
        delta: roundMoney(delta),
        after,
        source: "report",
        unit: uName,
        reportId: reportId || null,
        changeTime: db.serverDate(),
      },
    });
  } catch (e) {
    // 商品不存在或已删除则跳过
    console.error("applyStockDelta error", e.errMsg || e.message);
  }
}

// 商品某单位的当前库存
function unitQuantity(product, unit) {
  if (Array.isArray(product.units) && product.units.length) {
    const u = product.units.find((x) => x.name === unit);
    return u ? Number(u.quantity || 0) : 0;
  }
  return Number(product.quantity || 0);
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const action = event.action || event.type;

  switch (action) {
    case "saveReport":
      return saveReport(OPENID, event);
    case "updateReport":
      return updateReport(OPENID, event);
    case "listReports":
      return listReports(OPENID, event);
    case "getReport":
      return getReport(OPENID, event);
    case "setStatus":
      return setStatus(OPENID, event);
    case "deleteReport":
      return deleteReport(OPENID, event);
    case "restoreReport":
      return restoreReport(OPENID, event);
    case "purgeReport":
      return purgeReport(OPENID, event);
    case "purgeAllTrash":
      return purgeAllTrash(OPENID, event);
    case "restoreAllTrash":
      return restoreAllTrash(OPENID, event);
    case "getPriceHistory":
      return getPriceHistory(OPENID, event);
    case "getOpenId":
      return { openid: OPENID };
    default:
      return { success: false, msg: "未知操作：" + action };
  }
};

// 明细行清洗 + 商品改价联动（商品/工时统一处理，事务内调用）
async function processItems(t, OPENID, items) {
  const cleanItems = [];

  for (const item of items) {
    const quantity = roundMoney(Number(item.quantity) || 0);
    const price = roundMoney(Number(item.price) || 0);
    const amount = roundMoney(price * quantity);

    if (item.type === "goods") {
      const productId = item.productId;
      let product = null;
      try {
        const doc = await t.collection("products").doc(productId).get();
        product = doc.data;
      } catch (e) {
        // 商品已被删除：保留单据行，跳过价格同步
      }

      let unit = (item.unit || "").trim() || "个";
      if (product) {
        unit = unit || product.unit || "个";
        const curSell = unitSellPrice(product, unit);
        // 价格被修改：同步该单位销售价 + 记录价格历史
        if (Math.abs(curSell - price) > 0.001) {
          const upd = updateUnitSellPrice(product, unit, price);
          const updateData = { units: upd.units, updateTime: db.serverDate() };
          if (upd.changedDefault) updateData.sellPrice = price;
          await t.collection("products").doc(product._id).update({ data: updateData });
          await t.collection("priceHistory").add({
            data: {
              _openid: OPENID,
              productId: product._id,
              productName: product.name,
              priceType: "sell",
              oldPrice: curSell,
              newPrice: price,
              unit,
              reportId: null,
              changeTime: db.serverDate(),
            },
          });
        }
      }

      cleanItems.push({
        type: "goods",
        productId: productId,
        name: item.name,
        unit,
        price,
        quantity,
        amount,
        remark: item.remark || "",
      });
    } else {
      // 工时费行：只填一个总金额
      const laborAmount = roundMoney(Number(item.amount) || 0);
      cleanItems.push({
        type: "labor",
        desc: item.desc || "安装工时费",
        unit: "工时",
        price: 0,
        quantity: 0,
        amount: laborAmount,
        remark: item.remark || "",
      });
    }
  }

  return cleanItems;
}

function validatePayload(customer, items) {
  if (!customer) return { ok: false, msg: "客户名称不能为空" };
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, msg: "报表明细不能为空" };
  }
  if (items.length > 50) return { ok: false, msg: "明细最多 50 行" };
  return { ok: true };
}

// 保存报表：事务内 插入报表 + 商品改价同步 + 价格历史
async function saveReport(OPENID, event) {
  const { customerName, date, items, remark, location, address, title } = event;
  const customer = (customerName || "").trim();

  const check = validatePayload(customer, items);
  if (!check.ok) return { success: false, msg: check.msg };

  try {
    const serviceNote = await getUserNote(OPENID);
    const reportId = await db.runTransaction(async (t) => {
      const cleanItems = await processItems(t, OPENID, items);
      const totalAmount = roundMoney(
        cleanItems.reduce((s, i) => s + i.amount, 0)
      );

      const reportData = {
        _openid: OPENID,
        openid: OPENID,
        title: (title || "").trim() || "报表",
        customerName: customer,
        date: date || "",
        items: cleanItems,
        totalAmount,
        remark: remark || "",
        serviceNote: serviceNote, // 账户绑定的服务说明
        address: address || "",
        status: "pending", // 待完成 / 进行中 / 已完成
        deleted: false,
        createTime: db.serverDate(),
      };
      // 有定位才写 location，避免写入 null 触发数据库报错
      if (location && location.latitude != null) {
        reportData.location = location;
      }
      const addRes = await t.collection("reports").add({ data: reportData });
      // 报表消耗库存：每个商品按对应单位扣减
      for (const it of cleanItems) {
        if (it.type === "goods" && it.productId && it.quantity) {
          await applyStockDelta(t, OPENID, it.productId, it.unit, -it.quantity, addRes._id);
        }
      }
      return addRes._id;
    });

    return { success: true, _id: reportId };
  } catch (e) {
    console.error("saveReport error", e);
    return { success: false, msg: "保存失败：" + (e.errMsg || e.message) };
  }
}

// 修改报表：事务内 更新报表字段 + 商品改价同步
async function updateReport(OPENID, event) {
  const { reportId, customerName, date, items, remark, location, address, title } = event;
  const customer = (customerName || "").trim();

  if (!reportId) return { success: false, msg: "缺少 reportId" };
  const check = validatePayload(customer, items);
  if (!check.ok) return { success: false, msg: check.msg };

  try {
    await db.runTransaction(async (t) => {
      // 校验存在性与归属
      let old;
      try {
        const doc = await t.collection("reports").doc(reportId).get();
        old = doc.data;
      } catch (e) {
        throw new Error("报表不存在");
      }
      if (old._openid !== OPENID && old.openid !== OPENID) {
        throw new Error("无权修改该报表");
      }

      const cleanItems = await processItems(t, OPENID, items);
      const totalAmount = roundMoney(
        cleanItems.reduce((s, i) => s + i.amount, 0)
      );
      const serviceNote = await getUserNote(OPENID);

      // 事务内只更新除 location 外的字段
      await t.collection("reports").doc(reportId).update({
        data: {
          title: (title || "").trim() || "报表",
          customerName: customer,
          date: date || "",
          items: cleanItems,
          totalAmount,
          remark: remark || "",
          serviceNote: serviceNote, // 账户绑定的服务说明
          address: address || "",
          updateTime: db.serverDate(),
        },
      });

      // 库存净调整（按 商品+单位）：恢复旧报表消耗，再扣新报表消耗
      const oldMap = {};
      (old.items || []).forEach((it) => {
        if (it.type === "goods" && it.productId) {
          const key = it.productId + "::" + (it.unit || "");
          oldMap[key] = (oldMap[key] || 0) + Number(it.quantity || 0);
        }
      });
      const newMap = {};
      cleanItems.forEach((it) => {
        if (it.type === "goods" && it.productId) {
          const key = it.productId + "::" + (it.unit || "");
          newMap[key] = (newMap[key] || 0) + Number(it.quantity || 0);
        }
      });
      const allKeys = new Set([...Object.keys(oldMap), ...Object.keys(newMap)]);
      for (const key of allKeys) {
        const delta = (oldMap[key] || 0) - (newMap[key] || 0);
        if (delta !== 0) {
          const [pid, unit] = key.split("::");
          await applyStockDelta(t, OPENID, pid, unit, delta, reportId);
        }
      }
    });

    // location 单独处理（事务外，正常 API）：先移除旧字段，再写入，
    // 避免库里旧值为 null 时嵌套对象 update 报 PathNotViable
    if (location && location.latitude != null) {
      await db
        .collection("reports")
        .doc(reportId)
        .update({ data: { location: db.command.remove() } });
      await db.collection("reports").doc(reportId).update({
        data: {
          location: {
            latitude: Number(location.latitude),
            longitude: Number(location.longitude),
            name: location.name || "",
            address: location.address || "",
          },
        },
      });
    } else {
      await db
        .collection("reports")
        .doc(reportId)
        .update({ data: { location: db.command.remove() } });
    }

    return { success: true, _id: reportId };
  } catch (e) {
    console.error("updateReport error", e);
    return { success: false, msg: (e.errMsg || e.message).replace(/^Error: /, "") };
  }
}

// 报表列表（分页；默认排除回收站，trash=true 只查回收站）
async function listReports(OPENID, event) {
  const page = Math.max(1, Number(event.page) || 1);
  const limit = Math.min(Number(event.limit) || 20, 100);
  const _ = db.command;
  const cond = { _openid: OPENID };
  if (event.trash) {
    cond.deleted = true;
  } else {
    cond.deleted = _.neq(true); // 兼容无 deleted 字段的旧数据
  }

  try {
    const total = (await db.collection("reports").where(cond).count()).total;
    const res = await db
      .collection("reports")
      .where(cond)
      .orderBy("createTime", "desc")
      .skip((page - 1) * limit)
      .limit(limit)
      .get();
    return { success: true, list: res.data, total };
  } catch (e) {
    console.error("listReports error", e);
    return { success: false, msg: e.errMsg || e.message };
  }
}

// 报表详情
async function getReport(OPENID, event) {
  const { reportId } = event;
  if (!reportId) return { success: false, msg: "缺少 reportId" };
  try {
    const doc = await db.collection("reports").doc(reportId).get();
    const r = doc.data;
    if (r._openid !== OPENID && r.openid !== OPENID) {
      return { success: false, msg: "无权访问该报表" };
    }
    return { success: true, report: r };
  } catch (e) {
    console.error("getReport error", e);
    return { success: false, msg: "报表不存在" };
  }
}

// 校验归属：返回报表文档或 null
async function findOwnedReport(OPENID, reportId) {
  try {
    const doc = await db.collection("reports").doc(reportId).get();
    const r = doc.data;
    if (r._openid !== OPENID && r.openid !== OPENID) return null;
    return r;
  } catch (e) {
    return null;
  }
}

// 设置报表状态：pending / doing / done
async function setStatus(OPENID, event) {
  const { reportId, status } = event;
  if (!reportId) return { success: false, msg: "缺少 reportId" };
  if (!["pending", "doing", "done"].includes(status)) {
    return { success: false, msg: "状态无效" };
  }
  const r = await findOwnedReport(OPENID, reportId);
  if (!r) return { success: false, msg: "报表不存在或无权操作" };
  try {
    await db.collection("reports").doc(reportId).update({ data: { status } });
    return { success: true };
  } catch (e) {
    console.error("setStatus error", e);
    return { success: false, msg: e.errMsg || e.message };
  }
}

// 软删除：移入回收站（并回补库存）
async function deleteReport(OPENID, event) {
  const { reportId } = event;
  if (!reportId) return { success: false, msg: "缺少 reportId" };
  const r = await findOwnedReport(OPENID, reportId);
  if (!r) return { success: false, msg: "报表不存在或无权操作" };
  try {
    await db.runTransaction(async (t) => {
      await t.collection("reports").doc(reportId).update({
        data: { deleted: true, deleteTime: db.serverDate() },
      });
      // 回补报表消耗的库存（按单位）
      for (const it of r.items || []) {
        if (it.type === "goods" && it.productId && it.quantity) {
          await applyStockDelta(t, OPENID, it.productId, it.unit, Number(it.quantity), reportId);
        }
      }
    });
    return { success: true };
  } catch (e) {
    console.error("deleteReport error", e);
    return { success: false, msg: e.errMsg || e.message };
  }
}

// 恢复报表时：商品已彻底删除（products 里不存在）则按报表明细重建，
// 商品彻底删除时其价格/数量历史已级联清理，进价按 0 恢复，售价取报表行单价，库存从 0 起扣
async function ensureProductForRestore(t, OPENID, item) {
  try {
    const doc = await t.collection("products").doc(item.productId).get();
    if (doc.data) return; // 商品还在，直接恢复库存即可
  } catch (e) {
    // 商品不存在，走重建
  }
  const unit = (item.unit || "").trim() || "个";
  const sellPrice = Number(item.price) || 0;
  await t.collection("products").add({
    data: {
      _id: item.productId,
      _openid: OPENID,
      name: item.name || "恢复商品",
      unit,
      units: [{ name: unit, costPrice: 0, sellPrice, quantity: 0 }],
      costPrice: 0,
      sellPrice,
      quantity: 0,
      supplier: "",
      categoryPath: [],
      remark: "",
      createTime: db.serverDate(),
      updateTime: db.serverDate(),
    },
  });
}

// 从回收站恢复（并重新扣减库存）；商品已彻底删除时重建该商品
async function restoreReport(OPENID, event) {
  const { reportId } = event;
  if (!reportId) return { success: false, msg: "缺少 reportId" };
  const r = await findOwnedReport(OPENID, reportId);
  if (!r) return { success: false, msg: "报表不存在或无权操作" };
  try {
    await db.runTransaction(async (t) => {
      await t.collection("reports").doc(reportId).update({
        data: { deleted: false, deleteTime: db.command.remove() },
      });
      for (const it of r.items || []) {
        if (it.type === "goods" && it.productId && it.quantity) {
          await ensureProductForRestore(t, OPENID, it);
          await applyStockDelta(t, OPENID, it.productId, it.unit, -Number(it.quantity), reportId);
        }
      }
    });
    return { success: true };
  } catch (e) {
    console.error("restoreReport error", e);
    return { success: false, msg: e.errMsg || e.message };
  }
}

// 回收站中彻底删除
async function purgeReport(OPENID, event) {
  const { reportId } = event;
  if (!reportId) return { success: false, msg: "缺少 reportId" };
  const r = await findOwnedReport(OPENID, reportId);
  if (!r) return { success: false, msg: "报表不存在或无权操作" };
  try {
    await db.collection("reports").doc(reportId).remove();
    return { success: true };
  } catch (e) {
    console.error("purgeReport error", e);
    return { success: false, msg: e.errMsg || e.message };
  }
}

// 按条件分批删光（循环查-删，兼容数量超过单次 limit 的情况）
async function removeAllByQuery(collectionName, cond) {
  let removed = 0;
  for (;;) {
    const res = await db.collection(collectionName).where(cond).limit(100).get();
    if (!res.data || res.data.length === 0) break;
    for (const doc of res.data) {
      await db.collection(collectionName).doc(doc._id).remove();
      removed++;
    }
  }
  return removed;
}

// 彻底删除全部已删除的商品，并级联清理其价格/数量历史；
// 仍被报表引用的商品跳过（含回收站里的报表，避免恢复报表时丢失重建数据）
async function purgeProducts(OPENID) {
  let removed = 0;
  let skipped = 0;
  for (;;) {
    const res = await db
      .collection("products")
      .where({ _openid: OPENID, deleted: true })
      .limit(100)
      .get();
    if (!res.data || res.data.length === 0) break;
    for (const doc of res.data) {
      const pid = doc._id;
      // 查引用失败时按无引用处理，不阻塞清空
      let referenced = false;
      try {
        const ref = await db
          .collection("reports")
          .where({ "items.productId": pid })
          .count();
        referenced = (ref.total || 0) > 0;
      } catch (e) {
        referenced = false;
      }
      if (referenced) {
        skipped++;
        continue;
      }
      await removeAllByQuery("priceHistory", { productId: pid });
      await removeAllByQuery("quantityHistory", { productId: pid });
      await db.collection("products").doc(pid).remove();
      removed++;
    }
  }
  return { removed, skipped };
}

// 清空回收站：默认删除全部已删除的 报表 + 进货记录 + 商品；
// 传入 filter 时只清对应类型（all | report | purchase | product）
async function purgeAllTrash(OPENID, event) {
  try {
    const filter = (event && event.filter) || "all";
    let removedReports = 0;
    let removedPurchases = 0;
    let removedProducts = 0;
    let skippedProducts = 0;
    if (filter === "all" || filter === "report") {
      removedReports = await removeAllByQuery("reports", { _openid: OPENID, deleted: true });
    }
    if (filter === "all" || filter === "purchase") {
      removedPurchases = await removeAllByQuery("purchases", { _openid: OPENID, deleted: true });
    }
    if (filter === "all" || filter === "product") {
      const p = await purgeProducts(OPENID);
      removedProducts = p.removed;
      skippedProducts = p.skipped;
    }
    return {
      success: true,
      removed: removedReports + removedPurchases + removedProducts,
      removedReports,
      removedPurchases,
      removedProducts,
      skippedProducts,
    };
  } catch (e) {
    console.error("purgeAllTrash error", e);
    return { success: false, msg: e.errMsg || e.message };
  }
}

// 批量恢复简单类型（直接清 deleted 标记），循环查-改兼容数量超限
async function restoreAllByQuery(collectionName, cond) {
  let restored = 0;
  for (;;) {
    const res = await db.collection(collectionName).where(cond).limit(100).get();
    if (!res.data || res.data.length === 0) break;
    for (const doc of res.data) {
      await db.collection(collectionName).doc(doc._id).update({
        data: { deleted: false, deleteTime: db.command.remove() },
      });
      restored++;
    }
  }
  return restored;
}

// 恢复回收站：默认恢复全部已删除的 报表 + 进货记录 + 商品；
// 传入 filter 时只恢复对应类型（all | report | purchase | product）
// 报表逐条走 restoreReport（会重新扣减库存），进货记录/商品直接清标记
async function restoreAllTrash(OPENID, event) {
  try {
    const filter = (event && event.filter) || "all";
    let restoredReports = 0;
    let restoredPurchases = 0;
    let restoredProducts = 0;
    if (filter === "all" || filter === "report") {
      for (;;) {
        const res = await db
          .collection("reports")
          .where({ _openid: OPENID, deleted: true })
          .limit(100)
          .get();
        if (!res.data || res.data.length === 0) break;
        for (const doc of res.data) {
          const r = await restoreReport(OPENID, { reportId: doc._id });
          if (r.success) restoredReports++;
        }
      }
    }
    if (filter === "all" || filter === "purchase") {
      restoredPurchases = await restoreAllByQuery("purchases", { _openid: OPENID, deleted: true });
    }
    if (filter === "all" || filter === "product") {
      restoredProducts = await restoreAllByQuery("products", { _openid: OPENID, deleted: true });
    }
    return {
      success: true,
      restored: restoredReports + restoredPurchases + restoredProducts,
      restoredReports,
      restoredPurchases,
      restoredProducts,
    };
  } catch (e) {
    console.error("restoreAllTrash error", e);
    return { success: false, msg: e.errMsg || e.message };
  }
}

// 商品价格历史
async function getPriceHistory(OPENID, event) {
  const { productId, priceType } = event;
  if (!productId) return { success: false, msg: "缺少 productId" };
  try {
    const cond = { _openid: OPENID, productId };
    if (priceType) cond.priceType = priceType;
    const res = await db
      .collection("priceHistory")
      .where(cond)
      .orderBy("changeTime", "desc")
      .limit(100)
      .get();
    return { success: true, list: res.data };
  } catch (e) {
    console.error("getPriceHistory error", e);
    return { success: false, msg: e.errMsg || e.message };
  }
}
