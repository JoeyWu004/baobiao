// utils/purchaseState.js 进货记录（发票）状态反查：来源页 / 数量页 / 价格页的灰显共用
// 为什么不落库 voided 标记：发票被彻底删除后「文档不存在」本身就是信号；而软删 / 恢复
// 只需改 purchases 一个集合，多处维护标记容易漏。反查的真相唯一，且对历史数据立即正确。
const { db } = require("./cloud");

const CHUNK = 20; // 小程序端单次查询上限，分批查

// 反查一批 purchaseId 的状态，返回 { [id]: { exists, deleted, unknown } }
async function fetchPurchaseStates(ids) {
  const out = {};
  const uniq = [...new Set((ids || []).filter(Boolean))];
  if (!uniq.length) return out; // cmd.in([]) 会报错，空数组直接返回
  const _ = db().command;
  for (let i = 0; i < uniq.length; i += CHUNK) {
    const chunk = uniq.slice(i, i + CHUNK);
    try {
      const res = await db()
        .collection("purchases")
        .where({ _id: _.in(chunk) })
        .field({ _id: true, deleted: true })
        .limit(CHUNK)
        .get();
      (res.data || []).forEach((p) => {
        out[p._id] = { exists: true, deleted: p.deleted === true, unknown: false };
      });
    } catch (e) {
      console.error("查询进货记录状态失败", e);
      // 查询失败按「未知 = 正常」处理：宁可少灰显，也不可误报「发票已删除」
      chunk.forEach((id) => {
        out[id] = { exists: true, deleted: false, unknown: true };
      });
    }
  }
  uniq.forEach((id) => {
    if (!out[id]) out[id] = { exists: false, deleted: false, unknown: false };
  });
  return out;
}

// 单条记录的状态：ok（正常）| trash（在回收站）| purged（已彻底删除）
function stateOf(states, purchaseId) {
  if (!purchaseId) return "ok";
  const st = states[purchaseId];
  if (!st || st.unknown) return "ok";
  if (!st.exists) return "purged";
  return st.deleted ? "trash" : "ok";
}

// 行展示字段（三个页面共用）：状态、灰化 class、状态标签、是否还能点开
// 在回收站仍可点开（明细页会显示只读横幅）；已彻底删除则点不开
function markOf(states, purchaseId) {
  const purchaseState = stateOf(states, purchaseId);
  return {
    purchaseState,
    rowClass:
      purchaseState === "trash" ? "row-trash" : purchaseState === "purged" ? "row-voided" : "",
    statusText:
      purchaseState === "trash" ? "在回收站" : purchaseState === "purged" ? "发票已删除" : "",
    canOpen: purchaseState !== "purged",
  };
}

module.exports = { fetchPurchaseStates, stateOf, markOf };
