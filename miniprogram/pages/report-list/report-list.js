// pages/report-list/report-list.js 报表历史
const { callReportOps } = require("../../utils/cloud");
const { fmtMoney, fmtDateTime, toDate } = require("../../utils/format");
const { ensureLogin } = require("../../utils/auth");

const STATUS_MAP = {
  pending: { text: "待完成", cls: "st-pending" },
  doing: { text: "进行中", cls: "st-doing" },
  done: { text: "已完成", cls: "st-done" },
};

const STATUS_ORDER = { pending: 0, doing: 1, done: 2 };

Page({
  data: {
    list: [],
    filtered: [],
    keyword: "",
    loading: true,
    sortKey: "date",
    sortOrder: "desc",
    totalCount: 0,
  },

  onShow() {
    ensureLogin(); // 登录态过期时弹出登录提示
    this.loadList();
  },

  async loadList() {
    this.setData({ loading: true });
    // 读取本次生命周期内保持的排序设置
    const sort = getApp().globalData.reportSort || { key: "date", order: "desc" };
    this.setData({ sortKey: sort.key, sortOrder: sort.order });
    try {
      const res = await callReportOps("listReports", { limit: 50 });
      if (!res.result || !res.result.success) {
        throw new Error((res.result && res.result.msg) || "加载失败");
      }
      const list = res.result.list.map((r) => {
        const st = STATUS_MAP[r.status] || STATUS_MAP.pending;
        return {
          ...r,
          totalText: fmtMoney(r.totalAmount),
          timeText: r.createTime ? fmtDateTime(toDate(r.createTime)) : "",
          statusText: st.text,
          statusClass: st.cls,
          open: false, // 左滑展开
        };
      });
      const total = res.result.total || res.result.list.length;
      this.setData({ list, totalCount: total });
      this.applyFilter();
    } catch (e) {
      console.error("报表列表加载失败", e);
      wx.showToast({ title: "加载失败，请检查云环境", icon: "none" });
    } finally {
      this.setData({ loading: false });
      wx.stopPullDownRefresh();
    }
  },

  onSearch(e) {
    this.setData({ keyword: e.detail.value });
    this.applyFilter();
  },

  // 表头排序：点击切换 升/降序，并保存到 globalData（切页不重置）
  onSortTap(e) {
    const key = e.currentTarget.dataset.key;
    let order = "asc";
    if (this.data.sortKey === key) {
      order = this.data.sortOrder === "asc" ? "desc" : "asc";
    }
    getApp().globalData.reportSort = { key, order };
    this.setData({ sortKey: key, sortOrder: order });
    this.applyFilter();
  },

  // 按当前排序规则排序
  applySort(arr) {
    const key = this.data.sortKey;
    const dir = this.data.sortOrder === "asc" ? 1 : -1;
    const list = arr.slice();
    list.sort((a, b) => {
      if (key === "customer") {
        return (a.customerName || "").localeCompare(b.customerName || "", "zh") * dir;
      }
      if (key === "date") {
        const va = a.date || "";
        const vb = b.date || "";
        return (va < vb ? -1 : va > vb ? 1 : 0) * dir;
      }
      if (key === "status") {
        return ((STATUS_ORDER[a.status] != null ? STATUS_ORDER[a.status] : 0) -
          (STATUS_ORDER[b.status] != null ? STATUS_ORDER[b.status] : 0)) * dir;
      }
      if (key === "amount") {
        return ((a.totalAmount || 0) - (b.totalAmount || 0)) * dir;
      }
      return 0;
    });
    return list;
  },

  // 按 客户 / 商品 / 地点 过滤 + 排序
  applyFilter() {
    const kw = this.data.keyword.trim();
    let filtered = this.data.list;
    if (kw) {
      const lower = kw.toLowerCase();
      filtered = this.data.list.filter((r) => {
        // 客户
        if ((r.customerName || "").toLowerCase().includes(lower)) return true;
        // 地点（具体位置）
        if ((r.address || "").toLowerCase().includes(lower)) return true;
        // 明细里的商品名称 / 工时说明
        const items = r.items || [];
        for (const it of items) {
          const name = it.type === "goods" ? it.name : it.desc;
          if ((name || "").toLowerCase().includes(lower)) return true;
        }
        return false;
      });
    }
    filtered = this.applySort(filtered);
    this.setData({ filtered });
  },

  // ---------- 左滑选择状态 ----------
  onTouchStart(e) {
    const index = Number(e.currentTarget.dataset.index);
    const t = e.touches[0];
    this._touch = { index, startX: t.clientX, startY: t.clientY, horizontal: false };
  },

  onTouchMove(e) {
    const t = this._touch;
    if (!t) return;
    const dx = e.touches[0].clientX - t.startX;
    const dy = e.touches[0].clientY - t.startY;
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 10) {
      t.horizontal = true;
    }
  },

  onTouchEnd(e) {
    const t = this._touch;
    if (!t) return;
    this._touch = null;
    if (!t.horizontal) return;
    const dx = e.changedTouches[0].clientX - t.startX;
    if (dx < -40) {
      this.openRow(t.index);
    } else if (dx > 40) {
      this.closeAll();
    }
  },

  openRow(index) {
    const filtered = this.data.filtered.map((it, i) => ({
      ...it,
      open: i === index,
    }));
    this.setData({ filtered });
  },

  closeAll() {
    if (!this.data.filtered.some((it) => it.open)) return;
    this.setData({ filtered: this.data.filtered.map((it) => ({ ...it, open: false })) });
  },

  onSetStatus(e) {
    const index = Number(e.currentTarget.dataset.index);
    const status = e.currentTarget.dataset.status;
    const item = this.data.filtered[index];
    if (!item) return;
    callReportOps("setStatus", { reportId: item._id, status }).then((res) => {
      if (res.result && res.result.success) {
        const st = STATUS_MAP[status] || STATUS_MAP.pending;
        this.setData({
          [`filtered[${index}].status`]: status,
          [`filtered[${index}].statusText`]: st.text,
          [`filtered[${index}].statusClass`]: st.cls,
        });
        this.closeAll();
        wx.showToast({ title: "已设为" + st.text, icon: "none" });
      } else {
        wx.showToast({ title: "设置失败", icon: "none" });
      }
    });
  },

  // ---------- 长按删除（进回收站） ----------
  onLongPress(e) {
    this._longPressed = true;
    const index = Number(e.currentTarget.dataset.index);
    const item = this.data.filtered[index];
    if (!item) return;
    wx.showActionSheet({
      itemList: ["删除报表"],
      itemColor: "#fa5151",
      success: (res) => {
        if (res.tapIndex === 0) this.confirmDelete(item);
      },
    });
  },

  confirmDelete(item) {
    wx.showModal({
      title: "删除报表",
      content: `确定删除「${item.customerName}」的报表吗？删除后进入回收站，可在「我的」页恢复。`,
      confirmColor: "#fa5151",
      success: (res) => {
        if (!res.confirm) return;
        callReportOps("deleteReport", { reportId: item._id }).then((r) => {
          if (r.result && r.result.success) {
            wx.showToast({ title: "已移入回收站" });
            this.loadList();
          } else {
            wx.showToast({ title: "删除失败", icon: "none" });
          }
        });
      },
    });
  },

  goDetail(e) {
    if (this._longPressed) {
      this._longPressed = false;
      return;
    }
    const index = Number(e.currentTarget.dataset.index);
    const item = this.data.filtered[index];
    if (item && item.open) {
      this.closeAll(); // 展开状态下点击先收起
      return;
    }
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: "/pages/report-detail/report-detail?id=" + id });
  },

  goNew() {
    wx.navigateTo({ url: "/pages/report-edit/report-edit" });
  },

  onPullDownRefresh() {
    this.loadList();
  },
});
