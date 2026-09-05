// pages/goods-source/goods-source.js 商品来源
const { db, callReportOps } = require("../../utils/cloud");
const { fmtDate, toDate, fmtMoney } = require("../../utils/format");

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
    canRebuild: false, // sourceType === 'unknown' 时显示「重建来源」
    purchasesList: [], // 该商品全部进货记录（多张发票）
    purchaseCount: 0,
  },

  onLoad(options) {
    this.productId = options.id || "";
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

      this.setData({
        loading: false,
        name: p.name || "",
        unit: p.unit || "",
        sourceType,
        sourceLabel,
        sourceSupplier,
        sourceDate,
        purchaseId,
        canRebuild: sourceType === "unknown",
      });

      // 该商品全部进货记录（按名字匹配、跳过已删除、按日期正序），来源那条打「来源」标
      const purchases = await this.loadPurchases(p.name || "");
      const sourceId = (s && s.purchaseId) || "";
      const purchasesList = purchases
        .map((pu) => ({
          _id: pu._id,
          supplierText: pu.supplier || "（未填供应商）",
          date: pu.date || "",
          amount: Number(pu.totalAmount) || 0,
          amountText: fmtMoney(Number(pu.totalAmount) || 0),
          isSource: pu._id === sourceId,
        }))
        .sort((a, b) => (a.date || "9999-99-99").localeCompare(b.date || "9999-99-99"));
      this.setData({ purchasesList, purchaseCount: purchasesList.length });
    } catch (e) {
      console.error("商品来源加载失败", e);
      wx.showToast({ title: "加载失败", icon: "none" });
      this.setData({ loading: false });
    }
  },

  // 读取含该商品名的进货记录（进货 items 无 productId，按名字匹配）
  async loadPurchases(name) {
    const list = [];
    if (!name) return list;
    try {
      const pageSize = 100;
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
          if (p.deleted === true) continue;
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
    if (!this.data.purchaseId) return;
    wx.navigateTo({
      url: "/pages/purchase-detail/purchase-detail?id=" + this.data.purchaseId,
    });
  },

  // 从进货记录列表跳指定发票明细
  goPurchaseById(e) {
    const id = e.currentTarget.dataset.id;
    if (id) wx.navigateTo({ url: "/pages/purchase-detail/purchase-detail?id=" + id });
  },
});
