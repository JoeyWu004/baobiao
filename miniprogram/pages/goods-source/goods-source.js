// pages/goods-source/goods-source.js 商品来源
const { db, callReportOps } = require("../../utils/cloud");
const { fmtDate, toDate, fmtMoney } = require("../../utils/format");
const { fetchPurchaseStates, stateOf } = require("../../utils/purchaseState");

Page({
  data: {
    loading: true,
    name: "",
    unit: "",
    sourceType: "", // manual | invoice | purchase | unknown
    sourceLabel: "",
    sourceSupplier: "",
    sourceDate: "",
    purchaseId: "",
    sourceState: "ok", // ok | trash | purged：来源发票的状态
    canRebuild: false, // 来源未知或来源发票已删除时显示「重建来源」
    purchasesList: [], // 该商品全部进货记录（多张发票）
    purchaseCount: 0,
  },

  onLoad(options) {
    this.productId = options.id || "";
  },

  // 放 onShow 才能在进货记录被删除后返回本页时刷新（原来只有 onLoad，回来看到的是旧列表）
  onShow() {
    this.load();
  },

  async load() {
    if (!this.productId) {
      this.setData({ loading: false });
      return;
    }
    try {
      const res = await db().collection("products").doc(this.productId).get();
      const p = res.data || {};
      const s = p.source || null;

      let sourceType = "unknown";
      let sourceLabel = "未知来源";
      let sourceSupplier = "";
      let sourceDate = "";
      let purchaseId = "";

      if (s && s.type === "manual") {
        sourceType = "manual";
        sourceLabel = "手动录入";
        const d = toDate(p.createTime);
        sourceDate = d ? fmtDate(d) : "";
      } else if (s && s.type === "restore") {
        sourceType = "restore";
        sourceLabel = "报表恢复";
        const d = toDate(p.createTime);
        sourceDate = d ? fmtDate(d) : "";
      } else if (s && (s.type === "invoice" || s.type === "purchase")) {
        sourceType = s.type;
        sourceLabel = s.type === "invoice" ? "发票导入" : "进货记录";
        sourceSupplier = s.supplier || "";
        sourceDate = s.date || "";
        purchaseId = s.purchaseId || "";
      }

      // 来源发票被软删（回收站）/ 彻底删除 → 改写来源卡片，并清掉悬空引用
      let sourceState = "ok";
      if (purchaseId) {
        sourceState = stateOf(await fetchPurchaseStates([purchaseId]), purchaseId);
        if (sourceState === "purged") {
          sourceLabel = "发票已删除";
          sourceSupplier = "";
        } else if (sourceState === "trash") {
          sourceLabel = "发票在回收站";
        }
      }

      this.setData({
        loading: false,
        name: p.name || "",
        unit: p.unit || "",
        sourceType,
        sourceLabel,
        sourceSupplier,
        sourceDate,
        // 发票已彻底删除 → 不再渲染「查看进货记录 ›」（跳过去是白屏）
        purchaseId: sourceState === "purged" ? "" : purchaseId,
        sourceState,
        // 来源发票没了，给用户一个「重建来源」的修正入口
        canRebuild: sourceType === "unknown" || sourceState === "purged",
      });

      // 该商品全部进货记录（按名字匹配、按日期正序），来源那条打「来源」标；
      // 回收站里的照常列出并标注「在回收站」
      const purchases = await this.loadPurchases(p.name || "");
      const sourceId = (s && s.purchaseId) || "";
      const shownIds = {};
      const purchasesList = purchases.map((pu) => {
        shownIds[pu._id] = true;
        const trashed = pu.deleted === true;
        return {
          _id: pu._id,
          supplierText: pu.supplier || "（未填供应商）",
          date: pu.date || "",
          amount: Number(pu.totalAmount) || 0,
          amountText: fmtMoney(Number(pu.totalAmount) || 0),
          isSource: pu._id === sourceId,
          rowClass: trashed ? "row-trash" : "",
          statusText: trashed ? "在回收站" : "",
          ghost: false,
        };
      });

      // 发票文档已被彻底删除：没有内容可渲染，只能从残留的数量/价格历史反推，补一行灰色占位
      const ghosts = await this.loadGhostPurchases(this.productId, shownIds);
      Object.keys(ghosts).forEach((pid) => {
        const d = ghosts[pid] ? new Date(ghosts[pid]) : null;
        purchasesList.push({
          _id: pid,
          supplierText: "",
          date: d ? fmtDate(d) : "",
          amount: 0,
          amountText: "",
          isSource: pid === sourceId,
          rowClass: "row-voided",
          statusText: "发票已删除",
          ghost: true,
        });
      });

      purchasesList.sort((a, b) =>
        (a.date || "9999-99-99").localeCompare(b.date || "9999-99-99")
      );
      this.setData({ purchasesList, purchaseCount: purchasesList.length });
    } catch (e) {
      console.error("商品来源加载失败", e);
      wx.showToast({ title: "加载失败", icon: "none" });
      this.setData({ loading: false });
    }
  },

  // 读取含该商品名的进货记录（进货 items 无 productId，按名字匹配）
  // 回收站里的也读出来（用于标注「在回收站」）；已彻底删除的文档不存在，由 loadGhostPurchases 反推
  async loadPurchases(name) {
    const list = [];
    if (!name) return list;
    try {
      // pageSize 必须 ≤20（小程序端单次查询上限），原来写 100 会导致第一轮就 break，
      // 结果只读到前 20 条 —— 商品发票多于此数时列表是残缺的
      const pageSize = 20;
      let offset = 0;
      for (;;) {
        const res = await db()
          .collection("purchases")
          .where({ "items.name": name })
          .skip(offset)
          .limit(pageSize)
          .get();
        if (!res.data || res.data.length === 0) break;
        for (const p of res.data) {
          if (!(p.items || []).some((it) => it.name === name)) continue;
          list.push(p);
        }
        offset += res.data.length;
        if (res.data.length < pageSize) break;
      }
    } catch (e) {
      console.error("加载进货记录失败", e);
    }
    return list;
  },

  // 反推「幽灵发票」：发票文档已被彻底删除，但它的数量/价格历史还在。
  // 返回 { purchaseId: 最早一条历史的时间戳 }（0 表示取不到时间）。
  async loadGhostPurchases(productId, shownIds) {
    const ghosts = {};
    if (!productId) return ghosts;
    const gather = async (col) => {
      let offset = 0;
      for (let page = 0; page < 10; page++) {
        // 上限 10 页（200 条），避免老数据无限翻页
        const res = await db()
          .collection(col)
          .where({ productId })
          .skip(offset)
          .limit(20)
          .get();
        const rows = res.data || [];
        for (const h of rows) {
          const pid = h.purchaseId || "";
          if (!pid || shownIds[pid]) continue;
          // 只有发票/进货来源的记录才代表一张发票
          if (h.source !== "invoice" && h.source !== "purchase-edit") continue;
          const d = toDate(h.changeTime);
          const ms = d ? d.getTime() : 0;
          if (!ms) {
            if (ghosts[pid] === undefined) ghosts[pid] = 0;
          } else if (!ghosts[pid] || ms < ghosts[pid]) {
            ghosts[pid] = ms;
          }
        }
        if (rows.length < 20) break;
        offset += 20;
      }
    };
    try {
      await gather("quantityHistory");
      await gather("priceHistory");
    } catch (e) {
      console.error("反推已删除发票失败", e);
    }
    return ghosts;
  },

  // 重建来源：旧数据没 source，按「含该商品名的最早进货记录」推导，无则手动录入兜底
  async onRebuildSource() {
    const pid = this.productId;
    if (!pid) return;
    wx.showLoading({ title: "分析中…" });
    try {
      const res = await callReportOps("rebuildSource", { productId: pid, dryRun: true });
      const r = res.result;
      if (!r || !r.success) {
        wx.showToast({ title: (r && r.msg) || "分析失败", icon: "none" });
        return;
      }
      // 来源发票已不可用（在回收站 / 已彻底删除 / 明细里已没有该商品）：没有可推导的对象。
      // 这种时候只能保持现状 —— 改成「手动录入」会丢掉「它来自一张发票」这个事实，也会擦掉
      // purchaseId，让来源页那份「发票已删除」的标注一起消失。
      if (r.reason) {
        const why =
          r.reason === "gone"
            ? "该商品的来源发票已被彻底删除"
            : r.reason === "trash"
              ? "该商品的来源发票还在回收站里"
              : "该商品的来源发票明细里已经没有这个商品了";
        wx.showModal({
          title: "无法重建来源",
          content:
            why +
            "，也没有其它含该商品名的进货记录可以用来推导。\n\n保持当前来源不变。",
          showCancel: false,
        });
        return;
      }
      const content =
        "从该商品的进货记录推导最可能的来源；无进货记录则按建档时间记为手动录入。\n\n" +
        this._sourceLines(r).join("\n") +
        "\n\n确认写入？";
      wx.showModal({
        title: "重建来源",
        content,
        confirmColor: "#fa5151",
        success: (res2) => {
          if (res2.confirm) this._doRebuildSource(pid);
        },
      });
    } catch (e) {
      console.error("重建来源预览失败", e);
      wx.showToast({ title: "分析失败", icon: "none" });
    } finally {
      wx.hideLoading();
    }
  },

  _sourceLines(r) {
    const c = r.candidate || {};
    const label =
      c.type === "invoice" ? "来源：发票导入" : c.type === "purchase" ? "来源：进货记录" : "来源：手动录入";
    const arr = [label];
    if (c.supplier) arr.push("供应商：" + c.supplier);
    if (c.date) arr.push("日期：" + c.date);
    if (!r.hasPurchase) arr.push("依据：该商品无对应进货记录，按建档时间记为手动录入");
    return arr;
  },

  async _doRebuildSource(pid) {
    wx.showLoading({ title: "写入中…" });
    try {
      const res = await callReportOps("rebuildSource", { productId: pid, dryRun: false });
      const r = res.result;
      if (r && r.success) {
        wx.showToast({ title: "已写入来源", icon: "success" });
        this.load();
      } else {
        wx.showToast({ title: (r && r.msg) || "写入失败", icon: "none" });
      }
    } catch (e) {
      console.error("重建来源失败", e);
      wx.showToast({ title: "写入失败", icon: "none" });
    } finally {
      wx.hideLoading();
    }
  },

  goPurchase() {
    // 来源发票已彻底删除：不跳转（明细页已不存在），给明确提示
    if (this.data.sourceState === "purged") {
      wx.showToast({ title: "来源发票已彻底删除", icon: "none" });
      return;
    }
    if (!this.data.purchaseId) return;
    wx.navigateTo({
      url: "/pages/purchase-detail/purchase-detail?id=" + this.data.purchaseId,
    });
  },

  // 从进货记录列表跳指定发票明细
  goPurchaseById(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    // 灰行是按残留历史反推出来的，没有明细页可看 → 给明确提示而不是静默无响应
    // （按 _id 回表判断，不用 dataset：data-* 传布尔值经过序列化后类型不可靠）
    const row = this.data.purchasesList.find((it) => it._id === id);
    if (row && row.ghost) {
      wx.showToast({ title: "该发票已彻底删除", icon: "none" });
      return;
    }
    wx.navigateTo({ url: "/pages/purchase-detail/purchase-detail?id=" + id });
  },
});
