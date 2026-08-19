// pages/trash/trash.js 回收站：报表 + 进货记录 + 商品，恢复 / 彻底删除
const { db, callReportOps } = require("../../utils/cloud");
const { fmtMoney, fmtDateTime, toDate } = require("../../utils/format");

// 分批删光（客户端版），用于彻底删除商品时级联清理其价格/数量历史
async function removeAllByQuery(collectionName, cond) {
  let removed = 0;
  for (;;) {
    const res = await db().collection(collectionName).where(cond).limit(100).get();
    if (!res.data || res.data.length === 0) break;
    for (const doc of res.data) {
      await db().collection(collectionName).doc(doc._id).remove();
      removed++;
    }
  }
  return removed;
}

Page({
  data: {
    list: [],
    displayed: [],
    filter: "all", // all | report | purchase | product
    loading: true,
    totalCount: 0,
    repCount: 0,
    purCount: 0,
    prodCount: 0,
    displayCount: 0,
  },

  onShow() {
    this.loadList();
  },

  async loadList() {
    this.setData({ loading: true });
    try {
      // 已删除的报表
      const repRes = await callReportOps("listReports", { trash: true, limit: 100 });
      const reports = repRes.result && repRes.result.success ? repRes.result.list : [];
      const repTotal = (repRes.result && repRes.result.total) || reports.length;
      const list = reports.map((r) => ({
        type: "report",
        _id: r._id,
        title: r.title || "报表",
        name: r.customerName,
        date: r.date || "",
        totalText: fmtMoney(r.totalAmount),
        deleteText: r.deleteTime ? fmtDateTime(toDate(r.deleteTime)) : "",
      }));

      // 已删除的进货记录
      const _ = db().command;
      const purRes = await db()
        .collection("purchases")
        .where({ deleted: true })
        .orderBy("createTime", "desc")
        .limit(100)
        .get();
      const purTotal = (await db().collection("purchases").where({ deleted: true }).count()).total;
      purRes.data.forEach((p) => {
        list.push({
          type: "purchase",
          _id: p._id,
          title: "进货记录",
          name: p.supplier || "未填供应商",
          date: p.date || "",
          totalText: fmtMoney(p.totalAmount),
          deleteText: p.deleteTime ? fmtDateTime(toDate(p.deleteTime)) : "",
        });
      });

      // 已删除的商品（不在查询里排序，避免组合索引依赖，统一按删除时间在内存中排序）
      const prodRes = await db()
        .collection("products")
        .where({ deleted: true })
        .limit(100)
        .get();
      const prodTotal = (await db().collection("products").where({ deleted: true }).count()).total;
      prodRes.data.forEach((p) => {
        list.push({
          type: "product",
          _id: p._id,
          title: "商品",
          name: p.name,
          date: p.createTime ? fmtDateTime(toDate(p.createTime)) : "",
          quantityText: Number(p.quantity) || 0,
          totalText: "",
          deleteText: p.deleteTime ? fmtDateTime(toDate(p.deleteTime)) : "",
        });
      });

      // 按删除时间倒序
      list.sort((a, b) => (a.deleteText < b.deleteText ? 1 : -1));
      this.setData({
        list,
        totalCount: repTotal + purTotal + prodTotal,
        repCount: repTotal,
        purCount: purTotal,
        prodCount: prodTotal,
      });
      this.applyFilter();
    } catch (e) {
      console.error("回收站加载失败", e);
      wx.showToast({ title: "加载失败", icon: "none" });
    } finally {
      this.setData({ loading: false });
      wx.stopPullDownRefresh();
    }
  },

  setFilter(e) {
    const filter = e.currentTarget.dataset.filter;
    if (filter === this.data.filter) return;
    this.setData({ filter });
    this.applyFilter();
  },

  // 按当前筛选生成展示列表与数量
  applyFilter() {
    const filter = this.data.filter;
    const displayed =
      filter === "all"
        ? this.data.list
        : this.data.list.filter((it) => it.type === filter);
    const displayCount =
      filter === "all"
        ? this.data.totalCount
        : filter === "report"
          ? this.data.repCount
          : filter === "purchase"
            ? this.data.purCount
            : this.data.prodCount;
    this.setData({ displayed, displayCount });
  },

  goDetail(e) {
    const id = e.currentTarget.dataset.id;
    const type = e.currentTarget.dataset.type;
    if (type === "product") return; // 商品无详情页
    if (type === "purchase") {
      wx.navigateTo({ url: "/pages/purchase-detail/purchase-detail?id=" + id });
    } else {
      wx.navigateTo({ url: "/pages/report-detail/report-detail?id=" + id });
    }
  },

  onRestore(e) {
    const id = e.currentTarget.dataset.id;
    const type = e.currentTarget.dataset.type;
    const done = () => {
      wx.showToast({ title: "已恢复" });
      this.loadList();
    };
    const fail = () => wx.showToast({ title: "恢复失败", icon: "none" });
    if (type === "purchase" || type === "product") {
      const _ = db().command;
      const col = type === "purchase" ? "purchases" : "products";
      db()
        .collection(col)
        .doc(id)
        .update({ data: { deleted: false, deleteTime: _.remove() } })
        .then(done)
        .catch(fail);
    } else {
      callReportOps("restoreReport", { reportId: id }).then((res) => {
        if (res.result && res.result.success) done();
        else fail();
      });
    }
  },

  onPurge(e) {
    const id = e.currentTarget.dataset.id;
    const type = e.currentTarget.dataset.type;
    const name = e.currentTarget.dataset.name;
    const label =
      type === "purchase" ? "进货记录" : type === "product" ? "商品" : "报表";
    wx.showModal({
      title: "彻底删除",
      content: `将永久删除「${name}」的${label}，无法恢复，确定吗？`,
      confirmColor: "#fa5151",
      success: (res) => {
        if (!res.confirm) return;
        if (type === "product") {
          this.purgeProduct(id);
          return;
        }
        const done = () => {
          wx.showToast({ title: "已彻底删除" });
          this.loadList();
        };
        const fail = () => wx.showToast({ title: "删除失败", icon: "none" });
        if (type === "purchase") {
          db()
            .collection("purchases")
            .doc(id)
            .remove()
            .then(done)
            .catch(fail);
        } else {
          callReportOps("purgeReport", { reportId: id }).then((r) => {
            if (r.result && r.result.success) done();
            else fail();
          });
        }
      },
    });
  },

  // 彻底删除商品：先检查是否有报表引用（含回收站里的），有则拦截提示
  async purgeProduct(id) {
    const doPurge = async () => {
      try {
        await removeAllByQuery("priceHistory", { productId: id });
        await removeAllByQuery("quantityHistory", { productId: id });
        await db().collection("products").doc(id).remove();
        wx.showToast({ title: "已彻底删除" });
        this.loadList();
      } catch (e) {
        console.error("彻底删除商品失败", e);
        wx.showToast({ title: "删除失败", icon: "none" });
      }
    };
    try {
      const ref = await db()
        .collection("reports")
        .where({ "items.productId": id })
        .count();
      const n = ref.total || 0;
      if (n > 0) {
        wx.showModal({
          title: "该商品仍被报表引用",
          content: `有 ${n} 张报表引用了这个商品（含回收站里的报表）。彻底删除后，这些报表恢复时只能重建进价 0 的商品，且该商品的价格/数量记录会被清空。仍要彻底删除吗？`,
          confirmText: "仍要删除",
          confirmColor: "#fa5151",
          success: (res) => {
            if (res.confirm) doPurge();
          },
        });
      } else {
        doPurge();
      }
    } catch (e) {
      // 查引用失败时不阻塞删除
      console.error("检查商品引用失败", e);
      doPurge();
    }
  },

  // 清空回收站：按当前筛选只清对应类型（全部=报表+进货记录+商品）
  onClearAll() {
    const filter = this.data.filter;
    const count = this.data.displayCount;
    if (!count) return;
    const label =
      filter === "report"
        ? "报表"
        : filter === "purchase"
          ? "进货记录"
          : filter === "product"
            ? "商品"
            : "";
    const title = label ? "清空" + label : "清空回收站";
    const content = label
      ? `将永久删除回收站里的全部 ${count} 条已删除的${label}，无法恢复，确定吗？`
      : `将永久删除回收站里的全部 ${count} 条记录（报表 + 进货记录 + 商品），无法恢复，确定吗？`;
    wx.showModal({
      title,
      content,
      confirmText: "全部删除",
      confirmColor: "#fa5151",
      success: async (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: "清空中…", mask: true });
        try {
          const r = await callReportOps("purgeAllTrash", { filter });
          wx.hideLoading();
          if (r.result && r.result.success) {
            const sk = r.result.skippedProducts || 0;
            wx.showToast({
              title: sk
                ? `已删 ${r.result.removed || 0} 条，${sk} 个商品被报表引用未删`
                : `已删除 ${r.result.removed || 0} 条`,
              icon: "none",
            });
            this.loadList();
          } else {
            wx.showToast({ title: "清空失败", icon: "none" });
          }
        } catch (e) {
          wx.hideLoading();
          console.error("清空回收站失败", e);
          wx.showToast({ title: "清空失败", icon: "none" });
        }
      },
    });
  },

  // 恢复回收站：按当前筛选只恢复对应类型（全部=报表+进货记录+商品）
  onRestoreAll() {
    const filter = this.data.filter;
    const count = this.data.displayCount;
    if (!count) return;
    const label =
      filter === "report"
        ? "报表"
        : filter === "purchase"
          ? "进货记录"
          : filter === "product"
            ? "商品"
            : "";
    const title = label ? "恢复" + label : "恢复回收站";
    const content = label
      ? filter === "report"
        ? `将恢复回收站里的全部 ${count} 条已删除的报表，恢复后会重新扣减对应库存，确定吗？`
        : `将恢复回收站里的全部 ${count} 条已删除的${label}，确定吗？`
      : `将恢复回收站里的全部 ${count} 条记录（报表 + 进货记录 + 商品），报表会重新扣减库存，确定吗？`;
    wx.showModal({
      title,
      content,
      confirmText: "全部恢复",
      confirmColor: "#07c160",
      success: async (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: "恢复中…", mask: true });
        try {
          const r = await callReportOps("restoreAllTrash", { filter });
          wx.hideLoading();
          if (r.result && r.result.success) {
            wx.showToast({ title: `已恢复 ${r.result.restored || 0} 条` });
            this.loadList();
          } else {
            wx.showToast({ title: "恢复失败", icon: "none" });
          }
        } catch (e) {
          wx.hideLoading();
          console.error("恢复回收站失败", e);
          wx.showToast({ title: "恢复失败", icon: "none" });
        }
      },
    });
  },

  onPullDownRefresh() {
    this.loadList();
  },
});
