// pages/purchases/purchases.js 收支统计（按月汇总：收入 / 进货 / 净利润）
const { db, callReportOps } = require("../../utils/cloud");
const { fmtMoney, roundMoney } = require("../../utils/format");

// 金额带正负号："¥123.45" / "-¥45.00"（净利润可能为负）
function fmtSigned(n) {
  const v = roundMoney(n);
  return (v < 0 ? "-¥" : "¥") + Math.abs(v).toFixed(2);
}

const CLIENT_PAGE = 20; // 小程序端单次查询上限，循环分页读全
const REPORT_PAGE = 100; // reportOps 服务端分页单次上限

Page({
  data: {
    months: [], // [{ month, income, cost, profit, incomeText, costText, profitText, profitClass, list }]
    grand: null, // { incomeText, costText, profitText, profitClass }
    loading: true,
  },

  onShow() {
    this.load();
  },

  // 客户端分页读取全部进货记录（单次最多 20 条，循环读完避免截断）
  async fetchAllPurchases() {
    const _ = db().command;
    const all = [];
    let skip = 0;
    for (;;) {
      const res = await db()
        .collection("purchases")
        .where({ deleted: _.neq(true) })
        .orderBy("createTime", "desc")
        .skip(skip)
        .limit(CLIENT_PAGE)
        .get();
      const data = res.data || [];
      all.push(...data);
      if (data.length < CLIENT_PAGE) break;
      skip += CLIENT_PAGE;
    }
    return all;
  },

  // 通过 reportOps 分页读取全部报表（收入来源，服务端分页）
  async fetchAllReports() {
    const all = [];
    let page = 1;
    for (;;) {
      const res = await callReportOps("listReports", { page, limit: REPORT_PAGE });
      if (!res.result || !res.result.success) break;
      const list = res.result.list || [];
      all.push(...list);
      if (list.length < REPORT_PAGE) break;
      page++;
    }
    return all;
  },

  async load() {
    this.setData({ loading: true });
    try {
      const [purchases, reports] = await Promise.all([
        this.fetchAllPurchases(),
        this.fetchAllReports(),
      ]);

      const map = {};
      const ensure = (month) => {
        if (!map[month]) map[month] = { month, income: 0, cost: 0, list: [] };
        return map[month];
      };

      // 进货 → 每月成本 + 进货明细列表
      purchases.forEach((p) => {
        const month = (p.date || "").slice(0, 7) || "未知月份";
        const total = roundMoney(Number(p.totalAmount) || 0);
        const m = ensure(month);
        m.cost = roundMoney(m.cost + total);
        const itemNames = Array.isArray(p.items)
          ? p.items.map((it) => it.name).filter(Boolean)
          : [];
        m.list.push({
          ...p,
          totalText: fmtMoney(total),
          date: p.date || "",
          itemPreview:
            itemNames.slice(0, 3).join("、") + (itemNames.length > 3 ? " 等" : ""),
        });
      });

      // 报表（全部状态）→ 每月收入
      reports.forEach((r) => {
        const month = (r.date || "").slice(0, 7) || "未知月份";
        const m = ensure(month);
        m.income = roundMoney(m.income + (Number(r.totalAmount) || 0));
      });

      let gIncome = 0;
      let gCost = 0;
      const months = Object.keys(map)
        .map((key) => {
          const m = map[key];
          const profit = roundMoney(m.income - m.cost);
          gIncome = roundMoney(gIncome + m.income);
          gCost = roundMoney(gCost + m.cost);
          return {
            month: m.month,
            income: m.income,
            cost: m.cost,
            profit,
            incomeText: fmtMoney(m.income),
            costText: fmtMoney(m.cost),
            profitText: fmtSigned(profit),
            profitClass: profit < 0 ? "loss" : "profit",
            list: m.list,
          };
        })
        .sort((a, b) => (a.month < b.month ? 1 : -1));

      const gProfit = roundMoney(gIncome - gCost);
      this.setData({
        months,
        grand: {
          incomeText: fmtMoney(gIncome),
          costText: fmtMoney(gCost),
          profitText: fmtSigned(gProfit),
          profitClass: gProfit < 0 ? "loss" : "profit",
        },
      });
    } catch (e) {
      console.error("收支统计加载失败", e);
      wx.showToast({ title: "加载失败", icon: "none" });
    } finally {
      this.setData({ loading: false });
    }
  },

  goDetail(e) {
    if (this._longPressed) {
      this._longPressed = false;
      return;
    }
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: "/pages/purchase-detail/purchase-detail?id=" + id });
  },

  // 长按 → 删除进回收站（与报表一致）
  onLongPress(e) {
    this._longPressed = true;
    const id = e.currentTarget.dataset.id;
    wx.showActionSheet({
      itemList: ["删除这条进货记录"],
      itemColor: "#fa5151",
      success: (res) => {
        if (res.tapIndex === 0) this.confirmDelete(id);
      },
    });
  },

  confirmDelete(id) {
    wx.showModal({
      title: "删除进货记录",
      content: "删除后进入回收站，可在「我的」页恢复。",
      confirmColor: "#fa5151",
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await db()
            .collection("purchases")
            .doc(id)
            .update({ data: { deleted: true, deleteTime: db().serverDate() } });
          wx.showToast({ title: "已移入回收站" });
          this.load();
        } catch (e) {
          console.error("删除失败", e);
          wx.showToast({ title: "删除失败", icon: "none" });
        }
      },
    });
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },
});
