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
    // 若请求单位不是商品的有效单位，回退到真实默认单位，避免凭空新建"个"幻影单位
    const validUnits =
      Array.isArray(p.units) && p.units.length
        ? p.units.map((x) => (x.name || "").trim()).filter(Boolean)
        : [(p.unit || "个").trim()];
    let uName = (unit || "").trim() || p.unit || "个";
    if (validUnits.length && !validUnits.includes(uName)) {
      uName = validUnits[0];
    }
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

// 重算商品各单位当前库存：直接读源单据，而非回放数量流水。
// 口径 = Σ(发票/进货入库) − Σ(报表出库) + Σ(手动调整)。
// 单位统一归一化到商品有效单位（无效单位如幻影"个"回退到默认单位），
// 从而修掉「报表扣到幻影单位 / 扣减被吞」的原 bug（回放流水会把这些错误原样再现）。
// 报表 items 有 productId 可靠匹配（删除的报表已回补库存，跳过）；进货 items 无 productId，按名字匹配。
async function recomputeQtyByUnit(OPENID, product) {
  const validUnits =
    Array.isArray(product.units) && product.units.length
      ? product.units.map((u) => (u.name || "").trim()).filter(Boolean)
      : [(product.unit || "个").trim()];
  const defaultUnit = validUnits[0] || "个";
  const norm = (u) => {
    const nu = (u || "").trim() || "个";
    return validUnits.includes(nu) ? nu : defaultUnit;
  };
  const computed = {};
  const add = (unit, delta) => {
    const n = norm(unit);
    computed[n] = roundMoney((computed[n] || 0) + roundMoney(Number(delta) || 0));
  };

  const pageSize = 100;
  const productName = (product.name || "").trim();

  // ① 入库：发票/进货（按名字匹配）
  if (productName) {
    let offset = 0;
    for (;;) {
      const res = await db
        .collection("purchases")
        .where({ _openid: OPENID, "items.name": productName })
        .skip(offset)
        .limit(pageSize)
        .get();
      if (!res.data || res.data.length === 0) break;
      for (const p of res.data) {
        for (const it of p.items || []) {
          if (it.name === productName) add(it.unit, it.quantity);
        }
      }
      offset += res.data.length;
      if (res.data.length < pageSize) break;
    }
  }

  // ② 出库：报表（productId 可靠匹配；老报表行缺 productId 时按商品名匹配；
  //   合并取并集避免漏扣；删除的报表已回补库存，跳过不重复扣）
  {
    const seen = {};
    const reports = [];
    const qs = [{ "items.productId": product._id }];
    if (productName) qs.push({ "items.name": productName });
    for (const extra of qs) {
      let offset = 0;
      for (;;) {
        const res = await db
          .collection("reports")
          .where(Object.assign({ _openid: OPENID }, extra))
          .skip(offset)
          .limit(pageSize)
          .get();
        if (!res.data || res.data.length === 0) break;
        for (const r of res.data) {
          if (!seen[r._id]) {
            seen[r._id] = true;
            reports.push(r);
          }
        }
        offset += res.data.length;
        if (res.data.length < pageSize) break;
      }
    }
    for (const r of reports) {
      if (r.deleted === true) continue;
      for (const it of r.items || []) {
        const hit =
          it.type === "goods" &&
          (it.productId === product._id ||
            (productName && (it.name || "").trim() === productName));
        if (hit) add(it.unit, -Number(it.quantity) || 0);
      }
    }
  }

  // ③ 手动调整：quantityHistory source==='manual'
  {
    let offset = 0;
    for (;;) {
      const res = await db
        .collection("quantityHistory")
        .where({ _openid: OPENID, productId: product._id, source: "manual" })
        .skip(offset)
        .limit(pageSize)
        .get();
      if (!res.data || res.data.length === 0) break;
      for (const h of res.data) add(h.unit, h.delta);
      offset += res.data.length;
      if (res.data.length < pageSize) break;
    }
  }

  return computed;
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
    case "rebuildQuantity":
      return rebuildQuantity(OPENID, event);
    case "syncReportPrice":
      return syncReportPrice(OPENID, event);
    case "rebuildSource":
      return rebuildSource(OPENID, event);
    case "syncProductName":
      return syncProductName(OPENID, event);
    case "seenInvoiceDigests":
      return seenInvoiceDigests(OPENID);
    case "backfillQtyPurchase":
      return backfillQtyPurchase(OPENID, event);
    case "backfillPriceLinks":
      return backfillPriceLinks(OPENID, event);
    case "mergeProduct":
      return mergeProduct(OPENID, event);
    case "getOpenId":
      return { openid: OPENID };
    default:
      return { success: false, msg: "未知操作：" + action };
  }
};

// 明细行清洗 + 商品改价联动（商品/工时统一处理，事务内调用）
async function processItems(t, OPENID, items, priceEvents) {
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

      let unit = (item.unit || "").trim();
      if (product) {
        // 校验单位是否为商品的有效单位；为空或不匹配时回退到真实默认单位，避免扣到幻影"个"单位
        const validUnits =
          Array.isArray(product.units) && product.units.length
            ? product.units.map((x) => (x.name || "").trim()).filter(Boolean)
            : [(product.unit || "个").trim()];
        if (!unit || !validUnits.includes(unit)) {
          unit = (product.unit || "").trim() || validUnits[0] || "个";
        }
        const curSell = unitSellPrice(product, unit);
        // 价格被修改：同步该单位销售价；价格历史先收集（reportId 要等报表 id 生成后由调用方补写）
        if (Math.abs(curSell - price) > 0.001) {
          const upd = updateUnitSellPrice(product, unit, price);
          const updateData = { units: upd.units, updateTime: db.serverDate() };
          if (upd.changedDefault) updateData.sellPrice = price;
          await t.collection("products").doc(product._id).update({ data: updateData });
          if (priceEvents) {
            priceEvents.push({
              productId: product._id,
              productName: product.name,
              priceType: "sell",
              oldPrice: curSell,
              newPrice: price,
              unit,
            });
          }
        }
      }

      cleanItems.push({
        type: "goods",
        productId: productId,
        name: item.name,
        unit: unit || "个", // 商品已删除时无单位可循，回退"个"
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

// 报表行商品若缺 productId（如「进货明细/发票 → 用它开报表」带入的行，进货 items 不存 productId），
// 事务外先按商品名在本账户内补上 productId，使 processItems 能做改价同步/价格历史、库存能正确扣减。
// 商品已软删除则视为不存在（不补），报表行仍按原名保存、不联动。
async function resolveGoodsProductIds(OPENID, items) {
  const cache = {}; // name -> productId（"" 表示无匹配，避免重复查询）
  const out = [];
  for (const it of items || []) {
    if (it.type === "goods" && !(it.productId && String(it.productId).trim())) {
      const name = (it.name || "").trim();
      let pid = "";
      if (name) {
        if (name in cache) {
          pid = cache[name];
        } else {
          try {
            const res = await db
              .collection("products")
              .where({ _openid: OPENID, name })
              .limit(1)
              .get();
            const p = (res.data || [])[0];
            pid = p && !p.deleted ? p._id : "";
          } catch (e) {
            pid = "";
          }
          cache[name] = pid;
        }
      }
      out.push({ ...it, productId: pid });
    } else {
      out.push(it);
    }
  }
  return out;
}

// 保存报表：事务内 插入报表 + 商品改价同步 + 价格历史
async function saveReport(OPENID, event) {
  const { customerName, date, items, remark, location, address, title } = event;
  const customer = (customerName || "").trim();

  const check = validatePayload(customer, items);
  if (!check.ok) return { success: false, msg: check.msg };

  try {
    const serviceNote = await getUserNote(OPENID);
    // 缺 productId 的商品行先按名补齐（事务内不能 where 查询，故放在事务外）
    const resolvedItems = await resolveGoodsProductIds(OPENID, items);
    const priceEvents = [];
    const reportId = await db.runTransaction(async (t) => {
      const cleanItems = await processItems(t, OPENID, resolvedItems, priceEvents);
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
      // 补写本次改价触发的价格历史（reportId 现在已知）
      for (const ev of priceEvents) {
        await t.collection("priceHistory").add({
          data: {
            _openid: OPENID,
            productId: ev.productId,
            productName: ev.productName,
            priceType: ev.priceType,
            oldPrice: ev.oldPrice,
            newPrice: ev.newPrice,
            unit: ev.unit,
            source: "report",
            reportId: addRes._id,
            changeTime: db.serverDate(),
          },
        });
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
    // 缺 productId 的商品行先按名补齐（事务内不能 where 查询，故放在事务外）
    const resolvedItems = await resolveGoodsProductIds(OPENID, items);
    const priceEvents = [];
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

      const cleanItems = await processItems(t, OPENID, resolvedItems, priceEvents);
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
      // 补写本次改价触发的价格历史（报表已更新，reportId 已知）
      for (const ev of priceEvents) {
        await t.collection("priceHistory").add({
          data: {
            _openid: OPENID,
            productId: ev.productId,
            productName: ev.productName,
            priceType: ev.priceType,
            oldPrice: ev.oldPrice,
            newPrice: ev.newPrice,
            unit: ev.unit,
            source: "report",
            reportId,
            changeTime: db.serverDate(),
          },
        });
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
      source: { type: "restore" },
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

// 重建商品数量记录：按该商品全部数量变动记录（含手动，手动真实增减）重算各单位当前库存。
// 保留所有历史记录（不删除）；是否删除旧手动记录由用户后续自行处理。
// 重建后补记：老报表行缺 productId 从未写过 quantityHistory（当年报表根本没扣过库存/记账），
// 重算已把它们计入库存；这里再把缺失的「报表出库」数量记录补生成，让数量历史页看得到、能点跳。
// 幂等：按 (reportId, 单位) 检查是否已有 source=report 记录，已有则跳过；changeTime 取报表 createTime。
async function ensureReportQtyLedger(OPENID, product) {
  const productId = product._id;
  const name = (product.name || "").trim();
  const cmd = db.command;
  const pageSize = 100;
  const validUnits =
    Array.isArray(product.units) && product.units.length
      ? product.units.map((u) => (u.name || "").trim()).filter(Boolean)
      : [(product.unit || "个").trim()];
  const defaultUnit = validUnits[0] || "个";
  const norm = (u) => {
    const nu = (u || "").trim() || "个";
    return validUnits.includes(nu) ? nu : defaultUnit;
  };
  const ts = (v) => {
    if (!v) return NaN;
    const d = v instanceof Date ? v : new Date(v);
    return d.getTime();
  };

  // 该商品已有 report 类数量记录（用于判重）
  const existing = new Set();
  {
    let offset = 0;
    for (;;) {
      const res = await db
        .collection("quantityHistory")
        .where({ _openid: OPENID, productId, source: "report", reportId: cmd.exists(true) })
        .skip(offset)
        .limit(pageSize)
        .get();
      if (!res.data || res.data.length === 0) break;
      for (const h of res.data) {
        if (h.reportId) existing.add(h.reportId + "::" + norm(h.unit));
      }
      offset += res.data.length;
      if (res.data.length < pageSize) break;
    }
  }

  // 候选报表（未删除）：productId 命中 ∪ 商品名命中，按 _id 去重，按 (报表,单位) 汇总出库量
  const reportSeen = {};
  const reports = [];
  const qs = [{ "items.productId": productId }];
  if (name) qs.push({ "items.name": name });
  for (const extra of qs) {
    let offset = 0;
    for (;;) {
      const res = await db
        .collection("reports")
        .where(Object.assign({ _openid: OPENID }, extra))
        .skip(offset)
        .limit(pageSize)
        .get();
      if (!res.data || res.data.length === 0) break;
      for (const r of res.data) {
        if (!reportSeen[r._id]) {
          reportSeen[r._id] = true;
          reports.push(r);
        }
      }
      offset += res.data.length;
      if (res.data.length < pageSize) break;
    }
  }
  const reportAgg = {}; // reportId -> { t, agg:{unit:qty} }
  for (const r of reports) {
    if (r.deleted === true) continue;
    const agg = {};
    for (const it of r.items || []) {
      const hit =
        it.type === "goods" &&
        (it.productId === productId || (name && (it.name || "").trim() === name));
      if (!hit) continue;
      const qty = roundMoney(Number(it.quantity) || 0);
      if (qty <= 0) continue;
      const un = norm(it.unit);
      agg[un] = roundMoney((agg[un] || 0) + qty);
    }
    if (Object.keys(agg).length) {
      reportAgg[r._id] = { r, t: ts(r.createTime), agg };
    }
  }

  // 需补记的 (报表,单位) → after 回放后填充
  const planMap = {}; // reportId::unit -> { reportId, unit, qty, after:null }
  for (const rid of Object.keys(reportAgg)) {
    const { r, agg } = reportAgg[rid];
    for (const un of Object.keys(agg)) {
      const key = rid + "::" + un;
      if (!existing.has(key)) {
        existing.add(key); // 本次运行内也判重
        planMap[key] = { reportId: rid, changeTime: r.createTime, unit: un, qty: agg[un], after: null };
      }
    }
  }
  if (!Object.keys(planMap).length) return 0;

  // 回放时间线（与 recomputeQtyByUnit 口径一致：进货入库 + 报表出库 + 手动调整），
  // 每个被回放事件后记下 running[unit]，供补记记录写 after（归零即显示 0）
  const events = []; // { t, seq, unit, d, tag }
  let seq = 0;
  const pushEv = (t, unit, d, tag) => {
    events.push({ t, seq: seq++, unit: norm(unit), d: roundMoney(Number(d) || 0), tag: tag || "" });
  };
  if (name) {
    let offset = 0;
    for (;;) {
      const res = await db
        .collection("purchases")
        .where({ _openid: OPENID, "items.name": name })
        .skip(offset)
        .limit(pageSize)
        .get();
      if (!res.data || res.data.length === 0) break;
      for (const p of res.data) {
        for (const it of p.items || []) {
          if ((it.name || "").trim() === name) pushEv(ts(p.createTime), it.unit, it.quantity);
        }
      }
      offset += res.data.length;
      if (res.data.length < pageSize) break;
    }
  }
  for (const rid of Object.keys(reportAgg)) {
    const { t, agg } = reportAgg[rid];
    for (const un of Object.keys(agg)) {
      pushEv(t, un, -agg[un], rid + "::" + un);
    }
  }
  {
    let offset = 0;
    for (;;) {
      const res = await db
        .collection("quantityHistory")
        .where({ _openid: OPENID, productId, source: "manual" })
        .skip(offset)
        .limit(pageSize)
        .get();
      if (!res.data || res.data.length === 0) break;
      for (const h of res.data) pushEv(ts(h.changeTime), h.unit, h.delta);
      offset += res.data.length;
      if (res.data.length < pageSize) break;
    }
  }
  events.sort((a, b) => (a.t - b.t) || (a.seq - b.seq));

  const running = {};
  const afterByKey = {};
  for (const ev of events) {
    if (isNaN(ev.t)) continue;
    running[ev.unit] = roundMoney((running[ev.unit] || 0) + ev.d);
    // 记录每个（报表,单位）出库事件后的当时库存，供补记/修复写 after
    if (ev.tag) afterByKey[ev.tag] = roundMoney(running[ev.unit]);
  }

  let added = 0;
  for (const key of Object.keys(planMap)) {
    const pl = planMap[key];
    const data = {
      _openid: OPENID,
      productId,
      productName: product.name,
      delta: -pl.qty,
      source: "report",
      unit: pl.unit,
      reportId: pl.reportId,
      // 记账时间为报表记录时间（补记也按变动时间展示）；after 用回放算出的当时库存（归零=0）
      changeTime: pl.changeTime || db.serverDate(),
    };
    const after = afterByKey[key];
    if (Number.isFinite(after)) data.after = after;
    try {
      await db.collection("quantityHistory").add({ data });
      added++;
    } catch (e) {
      // 单条失败忽略
    }
  }

  // 修复先前已补记但缺 after 的记录（当时省略了库存值 → 页面显示「—」），用回放值补上
  {
    let offset = 0;
    for (;;) {
      const res = await db
        .collection("quantityHistory")
        .where({ _openid: OPENID, productId, source: "report", after: cmd.exists(false) })
        .skip(offset)
        .limit(pageSize)
        .get();
      if (!res.data || res.data.length === 0) break;
      for (const h of res.data) {
        const key = h.reportId + "::" + norm(h.unit);
        const after = afterByKey[key];
        if (h.reportId && Number.isFinite(after)) {
          try {
            await db.collection("quantityHistory").doc(h._id).update({ data: { after } });
          } catch (e) {
            // 忽略单条失败
          }
        }
      }
      offset += res.data.length;
      if (res.data.length < pageSize) break;
    }
  }
  return added;
}

// dryRun=true 只返回 old/computed 供预览；dryRun=false 写回商品数量（不动价格），
// 并补生成缺失的「报表出库」数量记录（ensureReportQtyLedger）。
async function rebuildQuantity(OPENID, event) {
  const { productId, dryRun } = event;
  if (!productId) return { success: false, msg: "缺少 productId" };
  try {
    let product;
    try {
      const doc = await db.collection("products").doc(productId).get();
      product = doc.data;
    } catch (e) {
      return { success: false, msg: "商品不存在" };
    }
    if (!product || (product._openid !== OPENID && product.openid !== OPENID)) {
      return { success: false, msg: "无权操作该商品" };
    }

    // 重算：直接读报表/进货/手动（而非回放流水），单位归一化到商品有效单位，修掉幻影单位吞扣
    const recomputed = await recomputeQtyByUnit(OPENID, product);
    // 商品当前各单位（兼容无 units 的旧数据）
    const curUnits =
      Array.isArray(product.units) && product.units.length
        ? product.units.slice()
        : [
            {
              name: product.unit || "个",
              costPrice: product.costPrice || 0,
              sellPrice: product.sellPrice || 0,
              quantity: product.quantity || 0,
            },
          ];

    const old = {};
    const computed = {};
    for (const u of curUnits) {
      const name = (u.name || "").trim() || "个";
      old[name] = roundMoney(Number(u.quantity) || 0);
      computed[name] = roundMoney(recomputed[name] !== undefined ? recomputed[name] : 0); // 无单据/流水 → 0（含遗留幻影单位清零）
    }
    // 单据里出现、但商品 units 里没有的单位（正常应已含于 units，预防旧数据无 units）
    Object.keys(recomputed).forEach((name) => {
      if (!(name in old)) {
        old[name] = 0;
        computed[name] = roundMoney(recomputed[name]);
      }
    });

    if (dryRun) {
      return { success: true, old, computed };
    }

    // 写回：只改数量，不动价格/单位结构
    const newUnits = curUnits.map((u) => {
      const name = (u.name || "").trim() || "个";
      return { ...u, quantity: computed[name] };
    });
    Object.keys(computed).forEach((name) => {
      if (!newUnits.some((u) => (u.name || "").trim() === name)) {
        newUnits.push({ name, costPrice: 0, sellPrice: 0, quantity: computed[name] });
      }
    });
    const updateData = { units: newUnits, updateTime: db.serverDate() };
    if (newUnits.length) updateData.quantity = roundMoney(newUnits[0].quantity);
    await db.collection("products").doc(productId).update({ data: updateData });

    // 补缺失的报表出库数量记录（老报表行缺 productId 从未记账）
    const addedLedger = await ensureReportQtyLedger(OPENID, product);

    return { success: true, old, computed, addedLedger };
  } catch (e) {
    console.error("rebuildQuantity error", e);
    return { success: false, msg: e.errMsg || e.message };
  }
}

// 补齐发票/进货类数量记录的 purchaseId（旧数据没存，点击记录无法跳转到对应进货明细页）。
// 匹配口径：读含该商品名的全部进货记录作候选，对该商品 source in (invoice/purchase-edit) 且缺 purchaseId
// 的数量记录，按时间就近挑选候选：
//   - invoice：进货记录的 createTime 与该记录 changeTime 最接近（发票入库时先建进货再写数量记录，毫秒级）；
//   - purchase-edit：进货记录的 updateTime 与该记录 changeTime 最接近（进货明细保存时先写数量记录再更新进货）。
// 仅在容差窗口内（默认 2 分钟）才写回，避免串到无关进货记录。报表记录始终带 reportId，不需要处理。
async function backfillQtyPurchase(OPENID, event) {
  const { productId, windowMs } = event || {};
  if (!productId) return { success: false, msg: "缺少 productId" };
  const window = Number(windowMs) > 0 ? Number(windowMs) : 2 * 60 * 1000; // 默认 2 分钟容差
  try {
    let product;
    try {
      const doc = await db.collection("products").doc(productId).get();
      product = doc.data;
    } catch (e) {
      return { success: false, msg: "商品不存在" };
    }
    if (!product || (product._openid !== OPENID && product.openid !== OPENID)) {
      return { success: false, msg: "无权操作该商品" };
    }

    const name = (product.name || "").trim();

    // 候选进货记录：含该商品名（含回收站，保证老记录仍可关联）
    const candidates = [];
    if (name) {
      const pageSize = 100;
      let offset = 0;
      for (;;) {
        const res = await db
          .collection("purchases")
          .where({ _openid: OPENID, "items.name": name })
          .skip(offset)
          .limit(pageSize)
          .get();
        if (!res.data || res.data.length === 0) break;
        for (const p of res.data) {
          if (!(p.items || []).some((it) => (it.name || "").trim() === name)) continue;
          candidates.push({ _id: p._id, createTime: p.createTime, updateTime: p.updateTime });
        }
        offset += res.data.length;
        if (res.data.length < pageSize) break;
      }
    }

    // 待关联的数量记录（invoice / purchase-edit 且尚无 purchaseId）
    const records = [];
    {
      const cmd = db.command;
      const cond = {
        _openid: OPENID,
        productId,
        source: cmd.in(["invoice", "purchase-edit"]),
        purchaseId: cmd.exists(false),
      };
      const pageSize = 100;
      let offset = 0;
      for (;;) {
        const res = await db
          .collection("quantityHistory")
          .where(cond)
          .skip(offset)
          .limit(pageSize)
          .get();
        if (!res.data || res.data.length === 0) break;
        records.push(...res.data);
        offset += res.data.length;
        if (res.data.length < pageSize) break;
      }
    }

    let matched = 0;
    let unmatched = 0;
    const ts = (v) => {
      if (!v) return NaN;
      const d = v instanceof Date ? v : new Date(v);
      return d.getTime();
    };
    for (const h of records) {
      const t = ts(h.changeTime);
      if (isNaN(t)) {
        unmatched++;
        continue;
      }
      let bestId = "";
      let best = Infinity;
      for (const c of candidates) {
        // purchase-edit 优先看 updateTime；invoice（及无 updateTime 时）看 createTime
        let score = NaN;
        if (h.source === "purchase-edit") {
          if (c.updateTime) score = Math.abs(ts(c.updateTime) - t);
          if (isNaN(score) && c.createTime) score = Math.abs(ts(c.createTime) - t);
        } else if (c.createTime) {
          score = Math.abs(ts(c.createTime) - t);
        }
        if (!isNaN(score) && score < best) {
          best = score;
          bestId = c._id;
        }
      }
      if (bestId && best <= window) {
        try {
          await db.collection("quantityHistory").doc(h._id).update({ data: { purchaseId: bestId } });
          matched++;
        } catch (e) {
          unmatched++;
        }
      } else {
        unmatched++;
      }
    }

    return { success: true, total: records.length, matched, unmatched };
  } catch (e) {
    console.error("backfillQtyPurchase error", e);
    return { success: false, msg: e.errMsg || e.message };
  }
}

// 从「最近的未删除报表」同步该商品售价 → 商品售价 + 价格历史。
// 修复历史报表行缺 productId 导致改价从未同步的商品：以 productId 或商品名匹配报表行，
// 取最近（按 createTime desc）一条，把行单价同步为该商品该单位售价并补一条 sell 价格历史。
// dryRun=true 只返回预览；报表行单位非法时回退到商品默认单位。
async function syncReportPrice(OPENID, event) {
  const { productId, dryRun } = event || {};
  if (!productId) return { success: false, msg: "缺少 productId" };
  const toMs = (v) => {
    if (!v) return NaN;
    const d = v instanceof Date ? v : new Date(v);
    return d.getTime();
  };
  try {
    let product;
    try {
      const doc = await db.collection("products").doc(productId).get();
      product = doc.data;
    } catch (e) {
      return { success: false, msg: "商品不存在" };
    }
    if (!product || (product._openid !== OPENID && product.openid !== OPENID)) {
      return { success: false, msg: "无权操作该商品" };
    }

    const name = (product.name || "").trim();
    const cmd = db.command;
    const cond = { _openid: OPENID, deleted: cmd.neq(true) };
    // 含该 productId 的报表 + 含该商品名的报表（旧行没 productId 只能按名匹配），合并去重
    const seen = {};
    const candidates = [];
    const queries = [Object.assign({}, cond, { "items.productId": productId })];
    if (name) queries.push(Object.assign({}, cond, { "items.name": name }));
    for (const q of queries) {
      try {
        const res = await db
          .collection("reports")
          .where(q)
          .orderBy("createTime", "desc")
          .limit(100)
          .get();
        for (const r of res.data || []) {
          if (seen[r._id]) continue;
          seen[r._id] = true;
          candidates.push(r);
        }
      } catch (e) {
        // 单个查询失败忽略
      }
    }
    candidates.sort((a, b) => toMs(b.createTime) - toMs(a.createTime));

    // 最近一条含该商品的有效 goods 行（优先与商品默认单位一致的行）
    let pick = null; // { report, item }
    for (const r of candidates) {
      const rows = (r.items || []).filter(
        (it) =>
          it.type === "goods" &&
          (it.productId === productId || (name && (it.name || "").trim() === name))
      );
      if (!rows.length) continue;
      const validUnits = Array.isArray(product.units) && product.units.length
        ? product.units.map((u) => (u.name || "").trim()).filter(Boolean)
        : [(product.unit || "个").trim()];
      const defUnit = validUnits[0] || "个";
      const row = rows.find((it) => (it.unit || "").trim() === defUnit) || rows[0];
      pick = { report: r, item: row };
      break;
    }
    if (!pick) return { success: true, hasSale: false };

    const item = pick.item;
    const report = pick.report;
    const validUnits = Array.isArray(product.units) && product.units.length
      ? product.units.map((u) => (u.name || "").trim()).filter(Boolean)
      : [(product.unit || "个").trim()];
    const rowUnit = (item.unit || "").trim();
    const unit = validUnits.includes(rowUnit)
      ? rowUnit
      : (product.unit || "").trim() || validUnits[0] || "个";
    const oldPrice = unitSellPrice(product, unit);
    const newPrice = roundMoney(Number(item.price) || 0);
    const changed = Math.abs(oldPrice - newPrice) > 0.001;

    const base = {
      success: true,
      hasSale: true,
      changed,
      oldPrice,
      newPrice,
      unit,
      reportId: report._id,
      reportTitle: report.title || "报表",
      reportDate: report.date || "",
      customer: report.customerName || "",
    };
    if (dryRun || !changed) return base;

    const upd = updateUnitSellPrice(product, unit, newPrice);
    const updateData = { units: upd.units, updateTime: db.serverDate() };
    if (upd.changedDefault) updateData.sellPrice = newPrice;
    await db.collection("products").doc(productId).update({ data: updateData });
    await db.collection("priceHistory").add({
      data: {
        _openid: OPENID,
        productId,
        productName: product.name,
        priceType: "sell",
        oldPrice,
        newPrice,
        unit,
        source: "report",
        reportId: report._id,
        // 售价日志应记「发生变动」的时间（即该报表记录的时间），而不是点同步按钮的时间
        changeTime: report.createTime || db.serverDate(),
      },
    });
    return base;
  } catch (e) {
    console.error("syncReportPrice error", e);
    return { success: false, msg: e.errMsg || e.message };
  }
}

// 补齐价格历史旧记录的来源（source/reportId/purchaseId），让价格历史页能显示原因并点跳转。
// 该商品 priceHistory 缺 source 的记录，按 记录.changeTime 就近匹配：
//   - sell（售价）→ 最近的未删除报表（createTime/updateTime），写 source=report + reportId；
//   - cost（进价）→ 最近的进货记录（createTime=发票导入 / updateTime=进货明细编辑），写 source + purchaseId。
// 仅在容差窗口内（默认 2 分钟）才写回，避免串到无关单据；手动静改等无对应单据的记录保持未标注。
async function backfillPriceLinks(OPENID, event) {
  const { productId, windowMs } = event || {};
  if (!productId) return { success: false, msg: "缺少 productId" };
  const window = Number(windowMs) > 0 ? Number(windowMs) : 2 * 60 * 1000;
  const toMs = (v) => {
    if (!v) return NaN;
    const d = v instanceof Date ? v : new Date(v);
    return d.getTime();
  };
  try {
    let product;
    try {
      const doc = await db.collection("products").doc(productId).get();
      product = doc.data;
    } catch (e) {
      return { success: false, msg: "商品不存在" };
    }
    if (!product || (product._openid !== OPENID && product.openid !== OPENID)) {
      return { success: false, msg: "无权操作该商品" };
    }
    const name = (product.name || "").trim();
    const cmd = db.command;

    // 报表候选（未删除）：productId 命中 或 商品名命中
    const reportSeen = {};
    const reports = [];
    {
      const qs = [{ "items.productId": productId }];
      if (name) qs.push({ "items.name": name });
      const pageSize = 100;
      for (const extra of qs) {
        let offset = 0;
        for (;;) {
          const cond = Object.assign(
            { _openid: OPENID, deleted: cmd.neq(true) },
            extra
          );
          const res = await db
            .collection("reports")
            .where(cond)
            .orderBy("createTime", "desc")
            .skip(offset)
            .limit(pageSize)
            .get();
          if (!res.data || res.data.length === 0) break;
          for (const r of res.data) {
            if (!reportSeen[r._id]) {
              reportSeen[r._id] = true;
              reports.push({ _id: r._id, createTime: r.createTime, updateTime: r.updateTime });
            }
          }
          offset += res.data.length;
          if (res.data.length < pageSize) break;
        }
      }
    }

    // 进货候选：含该商品名
    const purchases = [];
    if (name) {
      const pageSize = 100;
      let offset = 0;
      for (;;) {
        const res = await db
          .collection("purchases")
          .where({ _openid: OPENID, "items.name": name })
          .skip(offset)
          .limit(pageSize)
          .get();
        if (!res.data || res.data.length === 0) break;
        for (const p of res.data) {
          if (!(p.items || []).some((it) => (it.name || "").trim() === name)) continue;
          purchases.push({ _id: p._id, createTime: p.createTime, updateTime: p.updateTime });
        }
        offset += res.data.length;
        if (res.data.length < pageSize) break;
      }
    }

    // 待补来源的记录
    const records = [];
    {
      const pageSize = 100;
      let offset = 0;
      for (;;) {
        const res = await db
          .collection("priceHistory")
          .where({ _openid: OPENID, productId, source: cmd.exists(false) })
          .skip(offset)
          .limit(pageSize)
          .get();
        if (!res.data || res.data.length === 0) break;
        records.push(...res.data);
        offset += res.data.length;
        if (res.data.length < pageSize) break;
      }
    }

    let matched = 0;
    let unmatched = 0;
    const closest = (arr, t) => {
      // 返回最近单据：{ b:距离, bid:单据id, mode:'update'|'create' }，updateTime 与 createTime 取更近者
      let bid = "";
      let b = Infinity;
      let mode = "";
      for (const c of arr) {
        let d = NaN;
        let m = "";
        const du = c.updateTime ? Math.abs(toMs(c.updateTime) - t) : NaN;
        const dc = c.createTime ? Math.abs(toMs(c.createTime) - t) : NaN;
        if (!isNaN(du) && (isNaN(dc) || du <= dc)) {
          d = du;
          m = "update";
        } else if (!isNaN(dc)) {
          d = dc;
          m = "create";
        }
        if (!isNaN(d) && d < b) {
          b = d;
          bid = c._id;
          mode = m;
        }
      }
      return { b, bid, mode };
    };

    for (const h of records) {
      const t = toMs(h.changeTime);
      if (isNaN(t)) {
        unmatched++;
        continue;
      }
      let source = "";
      let link = "";
      if (h.reportId) {
        // 已带报表 id（如早前「同步售价」写入）：直接认领为报表来源，无需再按时间匹配
        source = "report";
        link = h.reportId;
      } else if (h.purchaseId) {
        source = "invoice";
        link = h.purchaseId;
      } else if (h.priceType === "sell") {
        // 售价 → 最近报表（保存或编辑报表产生）
        const rp = closest(reports, t);
        if (rp.bid && rp.b <= window) {
          source = "report";
          link = rp.bid;
        }
      } else {
        // 进价 → 最近进货：updateTime 更近=进货明细编辑，createTime 更近=发票导入
        const pp = closest(purchases, t);
        if (pp.bid && pp.b <= window) {
          source = pp.mode === "update" ? "purchase-edit" : "invoice";
          link = pp.bid;
        }
      }

      if (source && link) {
        try {
          const data = { source };
          if (source === "report") data.reportId = link;
          else data.purchaseId = link;
          await db.collection("priceHistory").doc(h._id).update({ data });
          matched++;
        } catch (e) {
          unmatched++;
        }
      } else {
        unmatched++;
      }
    }

    // 归一化售价日志时间：已带 reportId 的售价记录，若 changeTime 明显晚于该报表最近改动时间
    // （典型是此前「同步售价」按钮把时间记成了同步时刻），改回报表的 createTime/updateTime，
    // 让日志显示「变动发生时间」而非同步时间。
    {
      const pageSize = 100;
      const recs = [];
      let offset = 0;
      for (;;) {
        const res = await db
          .collection("priceHistory")
          .where({ _openid: OPENID, productId, source: "report", reportId: cmd.exists(true) })
          .skip(offset)
          .limit(pageSize)
          .get();
        if (!res.data || res.data.length === 0) break;
        recs.push(...res.data);
        offset += res.data.length;
        if (res.data.length < pageSize) break;
      }
      const meta = {}; // reportId -> Date（报表最近改动时间）
      for (const h of recs) {
        const rid = h.reportId;
        if (rid && !(rid in meta)) {
          let base = null;
          try {
            const d = await db.collection("reports").doc(rid).get();
            const r = d.data;
            if (r) base = r.updateTime || r.createTime || null;
          } catch (e) {
            base = null;
          }
          meta[rid] = base;
        }
        const base = meta[rid];
        const ct = toMs(h.changeTime);
        const bt = toMs(base);
        if (base && !isNaN(ct) && !isNaN(bt) && ct - bt > 5 * 60 * 1000) {
          try {
            await db.collection("priceHistory").doc(h._id).update({ data: { changeTime: base } });
          } catch (e) {
            // 忽略单条失败
          }
        }
      }
    }

    return { success: true, total: records.length, matched, unmatched };
  } catch (e) {
    console.error("backfillPriceLinks error", e);
    return { success: false, msg: e.errMsg || e.message };
  }
}

// 兼容 serverDate / 时间字符串 / Date → YYYY-MM-DD
function fmtYMD(v) {
  if (!v) return "";
  if (typeof v === "string") return v.slice(0, 10);
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d.getTime())) return "";
  const p = (n) => (n < 10 ? "0" + n : "" + n);
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

// 补齐商品来源：旧数据无 source，按「含该商品名的最早进货记录」推导来源；
// 无进货记录则按建档时间记为手动录入。dryRun 只返回候选，confirm 才写回。
async function rebuildSource(OPENID, event) {
  const { productId, dryRun } = event;
  if (!productId) return { success: false, msg: "缺少 productId" };
  try {
    let product;
    try {
      const doc = await db.collection("products").doc(productId).get();
      product = doc.data;
    } catch (e) {
      return { success: false, msg: "商品不存在" };
    }
    if (!product || (product._openid !== OPENID && product.openid !== OPENID)) {
      return { success: false, msg: "无权操作该商品" };
    }
    const name = (product.name || "").trim();
    const current = product.source || null;

    // 找含该商品名的进货记录，取最早一条（按 date 再按 createTime；跳过已删除，保证 purchaseId 可回看）
    let earliest = null;
    if (name) {
      const pageSize = 100;
      let offset = 0;
      for (;;) {
        const res = await db
          .collection("purchases")
          .where({ _openid: OPENID, "items.name": name })
          .skip(offset)
          .limit(pageSize)
          .get();
        if (!res.data || res.data.length === 0) break;
        for (const p of res.data) {
          if (p.deleted === true) continue;
          if (!(p.items || []).some((it) => it.name === name)) continue;
          if (!earliest) {
            earliest = p;
            continue;
          }
          const a = { d: p.date || "", t: p.createTime ? new Date(p.createTime).getTime() : 0 };
          const b = { d: earliest.date || "", t: earliest.createTime ? new Date(earliest.createTime).getTime() : 0 };
          if (a.d < b.d || (a.d === b.d && a.t < b.t)) earliest = p;
        }
        offset += res.data.length;
        if (res.data.length < pageSize) break;
      }
    }

    let candidate;
    let hasPurchase = !!earliest;
    if (earliest) {
      // invoice 导入的进货记录带 fileID，其余为手动录入的进货
      candidate = {
        type: earliest.fileID ? "invoice" : "purchase",
        purchaseId: earliest._id,
        date: earliest.date || "",
        supplier: earliest.supplier || "",
      };
    } else {
      candidate = {
        type: "manual",
        purchaseId: "",
        date: fmtYMD(product.createTime),
        supplier: "",
      };
    }

    if (dryRun) {
      return { success: true, current, candidate, hasPurchase };
    }
    await db.collection("products").doc(productId).update({
      data: { source: candidate, updateTime: db.serverDate() },
    });
    return { success: true, current, candidate, hasPurchase };
  } catch (e) {
    console.error("rebuildSource error", e);
    return { success: false, msg: e.errMsg || e.message };
  }
}

// 商品改名并同步到所有单据（报表明细按 productId、进货明细按旧名、价格/数量历史按 productId）。
// oldName 必须由调用方传入：goods/edit 保存时已先把 products.name 改成新名，函数内再读会拿到新名。
async function syncProductName(OPENID, event) {
  const { productId, oldName, newName } = event;
  if (!productId) return { success: false, msg: "缺少 productId" };
  const cleanOld = (oldName || "").trim();
  const cleanNew = (newName || "").trim();
  if (!cleanNew) return { success: false, msg: "新名称不能为空" };
  if (cleanOld === cleanNew) return { success: true, changed: false };

  try {
    let product;
    try {
      const doc = await db.collection("products").doc(productId).get();
      product = doc.data;
    } catch (e) {
      return { success: false, msg: "商品不存在" };
    }
    if (!product || (product._openid !== OPENID && product.openid !== OPENID)) {
      return { success: false, msg: "无权操作该商品" };
    }

    // 1. 商品规范名
    await db
      .collection("products")
      .doc(productId)
      .update({ data: { name: cleanNew, updateTime: db.serverDate() } });

    // 2. 报表明细：productId 命中；以及「缺 productId 但商品名为旧名」的老报表行一并改名并把 productId 补上，
    //    否则老报表页名称不更新、且后续按名重算/补记账/再改名都对不上。
    let reportCount = 0;
    let reportItemCount = 0;
    {
      const seen = {};
      const docs = [];
      const pageSize = 100;
      const qs = [{ _openid: OPENID, "items.productId": productId }];
      if (cleanOld) qs.push({ _openid: OPENID, "items.name": cleanOld });
      for (const extra of qs) {
        let offset = 0;
        for (;;) {
          const res = await db
            .collection("reports")
            .where(extra)
            .skip(offset)
            .limit(pageSize)
            .get();
          if (!res.data || res.data.length === 0) break;
          for (const r of res.data) {
            if (!seen[r._id]) {
              seen[r._id] = true;
              docs.push(r);
            }
          }
          offset += res.data.length;
          if (res.data.length < pageSize) break;
        }
      }
      for (const r of docs) {
        let matched = 0;
        const items = (r.items || []).map((it) => {
          if (it.type !== "goods") return it;
          const byId = it.productId === productId;
          const byOldName = cleanOld && (it.name || "").trim() === cleanOld && !byId;
          if (byId || byOldName) {
            matched++;
            return byOldName ? { ...it, name: cleanNew, productId } : { ...it, name: cleanNew };
          }
          return it;
        });
        if (matched) {
          reportItemCount += matched;
          await db.collection("reports").doc(r._id).update({ data: { items } });
          reportCount++;
        }
      }
    }

    // 3. 进货明细（无 productId，按旧名匹配）
    let purchaseCount = 0;
    let purchaseItemCount = 0;
    if (cleanOld) {
      let offset = 0;
      const pageSize = 100;
      for (;;) {
        const res = await db
          .collection("purchases")
          .where({ _openid: OPENID, "items.name": cleanOld })
          .skip(offset)
          .limit(pageSize)
          .get();
        if (!res.data || res.data.length === 0) break;
        for (const r of res.data) {
          const oldItems = r.items || [];
          purchaseItemCount += oldItems.filter((it) => it.name === cleanOld).length;
          const items = oldItems.map((it) =>
            it.name === cleanOld ? { ...it, name: cleanNew } : it
          );
          await db.collection("purchases").doc(r._id).update({ data: { items } });
          purchaseCount++;
        }
        offset += res.data.length;
        if (res.data.length < pageSize) break;
      }
    }

    // 4. 价格/数量历史（按 productId，可靠）
    let priceHistoryCount = 0;
    let quantityHistoryCount = 0;
    const phC = (await db
      .collection("priceHistory")
      .where({ _openid: OPENID, productId })
      .count()).total;
    if (phC > 0) {
      await db
        .collection("priceHistory")
        .where({ _openid: OPENID, productId })
        .update({ data: { productName: cleanNew } });
      priceHistoryCount = phC;
    }
    const qhC = (await db
      .collection("quantityHistory")
      .where({ _openid: OPENID, productId })
      .count()).total;
    if (qhC > 0) {
      await db
        .collection("quantityHistory")
        .where({ _openid: OPENID, productId })
        .update({ data: { productName: cleanNew } });
      quantityHistoryCount = qhC;
    }

    return {
      success: true,
      changed: true,
      reportCount,
      reportItemCount,
      purchaseCount,
      purchaseItemCount,
      priceHistoryCount,
      quantityHistoryCount,
    };
  } catch (e) {
    console.error("syncProductName error", e);
    return { success: false, msg: e.errMsg || e.message };
  }
}

// 返回「仍算已导入」的发票图片指纹集合。
// 旧版：只要 recognitionJobs 里有这条记录（哪怕发票已被删除/清空回收站）就算已导入，
//   导致重新导入同一张发票被拦截。现改为：只有该上传文件仍对应当前「未删除」的进货记录才算已导入，
//   发票被删除并清空回收站后不再拦截，允许重新导入同一张发票。
async function seenInvoiceDigests(OPENID) {
  try {
    const cmd = db.command;
    // 1. 最近已完成/已确认任务里的图片指纹（fileID -> digest；一张图对应一个上传文件）
    const res = await db
      .collection("recognitionJobs")
      .where({ _openid: OPENID, status: cmd.in(["done", "partial", "confirmed"]) })
      .orderBy("createTime", "desc")
      .limit(20)
      .get();
    const byFile = {};
    (res.data || []).forEach((j) => {
      const files = j.files || [];
      const results = j.results || [];
      files.forEach((f, i) => {
        if (f && f.digest && f.fileID && results[i]) byFile[f.fileID] = f.digest;
      });
    });
    const fileIDs = Object.keys(byFile);
    if (!fileIDs.length) return { success: true, digests: [] };

    // 2. 这些上传文件里，「仍存在且未删除」的进货记录对应哪些 fileID
    const live = new Set();
    const pageSize = 1000;
    let offset = 0;
    for (;;) {
      const ids = fileIDs.slice(offset, offset + pageSize);
      if (!ids.length) break;
      const r = await db
        .collection("purchases")
        .where({
          _openid: OPENID,
          fileID: cmd.in(ids),
          deleted: cmd.neq(true),
        })
        .field({ fileID: true })
        .get();
      (r.data || []).forEach((p) => {
        if (p.fileID) live.add(p.fileID);
      });
      offset += ids.length;
      if (offset >= fileIDs.length) break;
    }

    // 3. 只保留「进货记录仍存在」的指纹
    const digests = [];
    Object.keys(byFile).forEach((fid) => {
      if (live.has(fid)) digests.push(byFile[fid]);
    });
    return { success: true, digests };
  } catch (e) {
    console.error("seenInvoiceDigests error", e);
    return { success: true, digests: [] };
  }
}

// 合并商品：把识别错名的商品(drop)并入已存在的正确名商品(keep)。
// 合并单位库存、把 drop 的报表/价格历史/数量历史/进货引用全部改指到 keep，再软删除 drop 并清零其库存。
async function mergeProduct(OPENID, event) {
  const { keepId, dropId, keepName, dropName } = event;
  if (!keepId || !dropId) return { success: false, msg: "缺少商品id" };
  const keepNameClean = (keepName || "").trim();
  const dropNameClean = (dropName || "").trim();
  if (!keepNameClean) return { success: false, msg: "合并后名称不能为空" };

  try {
    const keepDoc = await db.collection("products").doc(keepId).get();
    const dropDoc = await db.collection("products").doc(dropId).get();
    const keep = keepDoc && keepDoc.data;
    const drop = dropDoc && dropDoc.data;
    if (!keep || !drop) return { success: false, msg: "商品不存在" };
    // 归属校验
    const keepOpenid = keep._openid || keep.openid;
    const dropOpenid = drop._openid || drop.openid;
    if (keepOpenid !== OPENID) return { success: false, msg: "无权限操作保留商品" };
    if (dropOpenid !== OPENID) return { success: false, msg: "无权限操作合并商品" };
    if (keep.deleted) return { success: false, msg: "保留商品已在回收站" };
    if (drop.deleted) return { success: false, msg: "合并商品已在回收站" };

    // 1. 合并单位（同名合并数量、保留 keep 的进/售价；不同名追加、用 drop 的进/售价）
    const mergedUnits = ensureUnits(keep);
    const dropUnits = ensureUnits(drop);
    for (const du of dropUnits) {
      const idx = mergedUnits.findIndex((u) => u.name === du.name);
      if (idx >= 0) {
        mergedUnits[idx] = { ...mergedUnits[idx], quantity: roundMoney(Number(mergedUnits[idx].quantity || 0) + Number(du.quantity || 0)) };
      } else {
        mergedUnits.push({
          name: du.name,
          costPrice: roundMoney(Number(du.costPrice || 0)),
          sellPrice: roundMoney(Number(du.sellPrice || 0)),
          quantity: roundMoney(Number(du.quantity || 0)),
        });
      }
    }
    const updateData = {
      units: mergedUnits,
      unit: mergedUnits[0].name,
      costPrice: roundMoney(Number(mergedUnits[0].costPrice || 0)),
      sellPrice: roundMoney(Number(mergedUnits[0].sellPrice || 0)),
      quantity: roundMoney(Number(mergedUnits[0].quantity || 0)),
      supplier: keep.supplier || "",
      name: keepNameClean,
      updateTime: db.serverDate(),
    };
    await db.collection("products").doc(keepId).update({ data: updateData });

    // 2. 报表：productId 为 dropId 的项改指 keep
    let reportCount = 0;
    {
      // productId 命中 drop，或「缺 productId 但名为 drop 旧名」的老报表行 → 一并改指 keep 并补 productId
      const seen = {};
      const docs = [];
      const pageSize = 100;
      const qs = [{ _openid: OPENID, "items.productId": dropId }];
      if (dropNameClean) qs.push({ _openid: OPENID, "items.name": dropNameClean });
      for (const extra of qs) {
        let offset = 0;
        for (;;) {
          const res = await db
            .collection("reports")
            .where(extra)
            .skip(offset)
            .limit(pageSize)
            .get();
          if (!res.data || res.data.length === 0) break;
          for (const r of res.data) {
            if (!seen[r._id]) {
              seen[r._id] = true;
              docs.push(r);
            }
          }
          offset += res.data.length;
          if (res.data.length < pageSize) break;
        }
      }
      for (const r of docs) {
        let matched = 0;
        const items = (r.items || []).map((it) => {
          if (it.type !== "goods") return it;
          const byId = it.productId === dropId;
          const byOldName = dropNameClean && (it.name || "").trim() === dropNameClean && !byId;
          if (byId || byOldName) {
            matched++;
            return { ...it, productId: keepId, name: keepNameClean };
          }
          return it;
        });
        if (matched) {
          await db.collection("reports").doc(r._id).update({ data: { items } });
          reportCount++;
        }
      }
    }

    // 3. 价格历史：productId 为 dropId 的改指 keep（批量）
    let priceHistoryCount = 0;
    if (dropNameClean) {
      const phC = (await db.collection("priceHistory").where({ _openid: OPENID, productId: dropId }).count()).total;
      if (phC > 0) {
        await db
          .collection("priceHistory")
          .where({ _openid: OPENID, productId: dropId })
          .update({ data: { productId: keepId, productName: keepNameClean } });
        priceHistoryCount = phC;
      }
    }

    // 4. 数量历史：productId 为 dropId 的改指 keep（批量，保证 rebuildQuantity 合计数=合并后库存）
    let quantityHistoryCount = 0;
    if (dropNameClean) {
      const qhC = (await db.collection("quantityHistory").where({ _openid: OPENID, productId: dropId }).count()).total;
      if (qhC > 0) {
        await db
          .collection("quantityHistory")
          .where({ _openid: OPENID, productId: dropId })
          .update({ data: { productId: keepId, productName: keepNameClean } });
        quantityHistoryCount = qhC;
      }
    }

    // 5. 进货明细：name 为 dropName 的项改为 keepName（仿 syncProductName 按旧名匹配）
    let purchaseCount = 0;
    if (dropNameClean) {
      let offset = 0;
      const pageSize = 100;
      for (;;) {
        const res = await db
          .collection("purchases")
          .where({ _openid: OPENID, "items.name": dropNameClean })
          .skip(offset)
          .limit(pageSize)
          .get();
        if (!res.data || res.data.length === 0) break;
        for (const r of res.data) {
          const items = (r.items || []).map((it) =>
            it.name === dropNameClean ? { ...it, name: keepNameClean } : it
          );
          await db.collection("purchases").doc(r._id).update({ data: { items } });
          purchaseCount++;
        }
        offset += res.data.length;
        if (res.data.length < pageSize) break;
      }
    }

    // 6. 软删除 drop：改名、清零库存，避免从回收站恢复时重复计库存
    await db.collection("products").doc(dropId).update({
      data: {
        deleted: true,
        deleteTime: db.serverDate(),
        name: keepNameClean,
        quantity: 0,
        units: dropUnits.map((u) => ({ ...u, quantity: 0 })),
      },
    });

    return {
      success: true,
      keepId,
      dropId,
      reportCount,
      priceHistoryCount,
      quantityHistoryCount,
      purchaseCount,
    };
  } catch (e) {
    console.error("mergeProduct error", e);
    return { success: false, msg: e.errMsg || e.message };
  }
}
