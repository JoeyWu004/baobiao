// pages/report-edit/report-edit.js 新建/编辑报表（核心页）
const { db, callReportOps } = require("../../utils/cloud");
const { fmtDate, fmtMoney, roundMoney } = require("../../utils/format");

Page({
  data: {
    mode: "add", // add | edit
    _id: "",
    title: "报表",
    customerName: "",
    date: "",
    remark: "",
    address: "",
    location: null,
    locating: false,
    items: [],
    totalAmount: 0,
    totalText: "0.00",
    showPicker: false,
    saving: false,
    saveBtnText: "保存报表",
  },

  onLoad(options) {
    this.setData({ date: fmtDate(new Date()) });
    this._uid = 0;

    if (options.id) {
      this.setData({ mode: "edit", _id: options.id, saveBtnText: "保存修改" });
      wx.setNavigationBarTitle({ title: "编辑报表" });
      this.loadReport(options.id);
    } else {
      // 发票识别的草稿预填
      const draft = getApp().globalData.reportDraft;
      if (draft && draft.items && draft.items.length) {
        getApp().globalData.reportDraft = null;
        const items = draft.items.map((it) => ({
          uid: this.newUid(),
          type: "goods",
          productId: it.productId || "",
          name: it.name,
          unit: it.unit || "个",
          price: Number(it.price) || 0,
          quantity: Number(it.quantity) || 0,
          originalPrice: Number(it.price) || 0,
          overridden: false,
          remark: it.remark || "",
        }));
        this.setData({ items, date: draft.date || this.data.date });
        this.recalc();
      }
    }
  },

  newUid() {
    this._uid += 1;
    return "item-" + this._uid + "-" + Date.now();
  },

  // 编辑模式：加载已有报表并预填
  async loadReport(id) {
    wx.showLoading({ title: "加载中…" });
    try {
      const res = await callReportOps("getReport", { reportId: id });
      if (!res.result || !res.result.success) {
        throw new Error((res.result && res.result.msg) || "加载失败");
      }
      const r = res.result.report;
      let items = (r.items || []).map((it) => {
        const base = {
          uid: this.newUid(),
          quantity: Number(it.quantity) || 1,
          price: Number(it.price) || 0,
        };
        if (it.type === "goods") {
          return {
            ...base,
            type: "goods",
            productId: it.productId,
            name: it.name,
            unit: it.unit || "个",
            units: [],
            originalPrice: base.price,
            overridden: false,
            remark: it.remark || "",
          };
        }
        return {
          uid: this.newUid(),
          type: "labor",
          desc: it.desc || "",
          unit: "工时",
          amount: Number(it.amount) || 0,
          remark: it.remark || "",
        };
      });
      // 拉取商品单位信息，支持编辑时切换单位
      const goodsIds = [
        ...new Set(
          items.filter((it) => it.type === "goods" && it.productId).map((it) => it.productId)
        ),
      ];
      const unitsMap = {};
      await Promise.all(
        goodsIds.map(async (pid) => {
          try {
            const pr = await db().collection("products").doc(pid).get();
            const u = pr.data.units;
            if (Array.isArray(u) && u.length) {
              unitsMap[pid] = u.map((x) => ({
                name: x.name || "个",
                sellPrice: roundMoney(Number(x.sellPrice) || 0),
              }));
            }
          } catch (err) {
            // 商品可能已删除
          }
        })
      );
      items = items.map((it) => {
        if (it.type === "goods" && it.productId && unitsMap[it.productId]) {
          it.units = unitsMap[it.productId];
        }
        return it;
      });
      this.setData({
        title: r.title || "报表",
        customerName: r.customerName || "",
        date: r.date || fmtDate(new Date()),
        remark: r.remark || "",
        address: r.address || "",
        location: r.location || null,
        items,
      });
      this.recalc();
    } catch (e) {
      console.error("报表加载失败", e);
      wx.showToast({ title: "加载失败", icon: "none" });
    } finally {
      wx.hideLoading();
    }
  },

  onTitleInput(e) {
    this.setData({ title: e.detail.value });
  },

  onCustomerInput(e) {
    this.setData({ customerName: e.detail.value });
  },

  onRemarkInput(e) {
    this.setData({ remark: e.detail.value });
  },

  onAddressInput(e) {
    this.setData({ address: e.detail.value });
  },

  // 定位（可选）：调用微信位置选择 API，返回坐标 + 地点；与文本框（门牌号等）相互独立
  locate() {
    if (this.data.locating) return;
    this.setData({ locating: true });
    wx.chooseLocation({
      success: (res) => {
        // res: { name, address, latitude, longitude }
        this.setData({
          location: {
            latitude: res.latitude,
            longitude: res.longitude,
            name: res.name || "",
            address: res.address || "",
          },
          locating: false,
        });
        // 不覆盖文本框，文本框用于门牌号等更具体描述
      },
      fail: (err) => {
        this.setData({ locating: false });
        const msg = (err && err.errMsg) || "";
        if (msg.includes("cancel")) return; // 用户取消，不算错误
        if (msg.includes("auth deny") || msg.includes("authorize")) {
          wx.showModal({
            title: "需要位置权限",
            content: "请在设置中允许获取位置信息后重试。",
            confirmText: "去设置",
            success: (m) => {
              if (m.confirm) wx.openSetting();
            },
          });
        } else if (msg.includes("privacy")) {
          wx.showModal({
            title: "隐私授权未配置",
            content:
              "请在微信公众平台后台「设置-服务内容声明-用户隐私保护指引」中声明「位置信息」，并启用隐私弹窗。",
            showCancel: false,
          });
        } else {
          wx.showToast({ title: "定位失败", icon: "none" });
        }
      },
    });
  },

  clearLocation() {
    this.setData({ location: null });
  },

  onDateChange(e) {
    this.setData({ date: e.detail.value });
  },

  openPicker() {
    this.setData({ showPicker: true });
  },

  closePicker() {
    this.setData({ showPicker: false });
  },

  onPickProducts(e) {
    const products = e.detail.products || [];
    this.setData({ showPicker: false });
    if (!products.length) return;
    const items = this.data.items.slice();
    let mergedCount = 0;
    // 逐个商品生成明细行；可用单位优先 product.units，否则单单位
    products.forEach((product) => {
      const units =
        Array.isArray(product.units) && product.units.length
          ? product.units.map((u) => ({
              name: u.name || "个",
              sellPrice: roundMoney(Number(u.sellPrice) || 0),
            }))
          : [{ name: product.unit || "个", sellPrice: roundMoney(Number(product.sellPrice) || 0) }];
      const price = units[0].sellPrice;
      const unit = units[0].name;
      // 已存在同商品同单位的行：数量加 1（避免重复行），保留原价格
      const existing = items.find(
        (it) => it.type === "goods" && it.productId === product._id && it.unit === unit
      );
      if (existing) {
        existing.quantity = (Number(existing.quantity) || 0) + 1;
        mergedCount += 1;
        return;
      }
      items.push({
        uid: this.newUid(),
        type: "goods",
        productId: product._id,
        name: product.name,
        units,
        unit,
        price,
        quantity: 1,
        amount: price,
        originalPrice: price,
        overridden: false,
        remark: "",
      });
    });
    this.setData({ items });
    this.recalc();
    if (mergedCount > 0) {
      wx.showToast({ title: "同商品已合并，数量加一", icon: "none" });
    }
  },

  // 切换商品行的单位（多单位商品）
  switchUnit(e) {
    const index = Number(e.currentTarget.dataset.index);
    const items = this.data.items.slice();
    const item = items[index];
    if (!item || item.type !== "goods" || !item.units || item.units.length < 2) return;
    const cur = item.units.findIndex((u) => u.name === item.unit);
    const next = item.units[(cur + 1) % item.units.length];
    item.unit = next.name;
    item.price = next.sellPrice;
    item.originalPrice = next.sellPrice;
    item.overridden = false;
    items[index] = item;
    this.setData({ items });
    this.recalc();
  },

  addLabor() {
    const item = {
      uid: this.newUid(),
      type: "labor",
      desc: "",
      unit: "工时",
      amount: 0,
      remark: "",
    };
    this.setData({ items: [...this.data.items, item] });
  },

  onItemInput(e) {
    const field = e.currentTarget.dataset.field; // price | quantity | desc
    const index = Number(e.currentTarget.dataset.index);
    const items = this.data.items.slice();
    const item = items[index];
    if (!item) return;

    let value = e.detail.value;
    if (field === "price" || field === "quantity" || field === "amount") {
      // 保留原始字符串：若立即 Number() 转换，输入"12."时小数点会被吞掉，导致无法输入小数
      item[field] = value;
      if (field === "price" && item.type === "goods") {
        item.overridden =
          Math.abs(Number(value) - item.originalPrice) > 0.001;
      }
    } else if (field === "remark") {
      item.remark = value;
    } else if (field === "desc") {
      item.desc = value;
    }
    items[index] = item;
    this.setData({ items });
    this.recalc();
  },

  // 长按商品/工时行：展开或收起备注编辑框
  toggleItemRemark(e) {
    const index = Number(e.currentTarget.dataset.index);
    const items = this.data.items.slice();
    const item = items[index];
    if (!item) return;
    item.remarkOpen = !item.remarkOpen;
    items[index] = item;
    this.setData({ items });
  },

  // 数量步进（- / +），下限为 0
  onQtyStep(e) {
    const index = Number(e.currentTarget.dataset.index);
    const delta = Number(e.currentTarget.dataset.delta);
    const items = this.data.items.slice();
    const item = items[index];
    if (!item || item.type !== "goods") return;
    const qty = Math.max(0, (Number(item.quantity) || 0) + delta);
    item.quantity = qty;
    items[index] = item;
    this.setData({ items });
    this.recalc();
  },

  removeItem(e) {
    const index = Number(e.currentTarget.dataset.index);
    const items = this.data.items.slice();
    items.splice(index, 1);
    this.setData({ items });
    this.recalc();
  },

  noop() {},

  recalc() {
    const items = this.data.items.map((it) => {
      const amount =
        it.type === "labor"
          ? roundMoney(Number(it.amount) || 0)
          : roundMoney(Number(it.price) * Number(it.quantity));
      return { ...it, amount, amountText: fmtMoney(amount) };
    });
    const totalAmount = roundMoney(items.reduce((s, i) => s + i.amount, 0));
    this.setData({
      items,
      totalAmount,
      totalText: fmtMoney(totalAmount),
    });
  },

  async onSave() {
    const { title, customerName, date, items, remark, address, location } = this.data;
    if (!customerName.trim()) {
      wx.showToast({ title: "请填写客户名称", icon: "none" });
      return;
    }
    if (!date) {
      wx.showToast({ title: "请选择日期", icon: "none" });
      return;
    }
    if (items.length === 0) {
      wx.showToast({ title: "请添加商品或工时", icon: "none" });
      return;
    }
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.type === "goods" && !it.name) {
        wx.showToast({ title: `第 ${i + 1} 行缺少商品`, icon: "none" });
        return;
      }
      if (it.type === "labor") {
        if (!it.desc.trim()) {
          wx.showToast({ title: `第 ${i + 1} 行请填写工时说明`, icon: "none" });
          return;
        }
        if (Number(it.amount) <= 0) {
          wx.showToast({ title: `第 ${i + 1} 行金额需大于 0`, icon: "none" });
          return;
        }
      } else if (Number(it.quantity) < 0) {
        wx.showToast({ title: `第 ${i + 1} 行数量不能为负数`, icon: "none" });
        return;
      }
    }

    this.setData({ saving: true });
    wx.showLoading({ title: "保存中…" });
    try {
      const payload = items.map((i) =>
        i.type === "goods"
          ? {
              type: "goods",
              productId: i.productId,
              name: i.name,
              unit: i.unit,
              price: Number(i.price),
              quantity: Number(i.quantity),
              remark: (i.remark || "").trim(),
            }
          : {
              type: "labor",
              desc: i.desc.trim(),
              amount: Number(i.amount),
              remark: (i.remark || "").trim(),
            }
      );

      const isEdit = this.data.mode === "edit";
      const base = {
        title: (title || "").trim() || "报表",
        customerName: customerName.trim(),
        date,
        items: payload,
        remark: remark.trim(),
        // 可选位置信息
        address: (address || "").trim(),
        location: location || null,
      };
      const req = isEdit
        ? callReportOps("updateReport", {
            reportId: this.data._id,
            ...base,
          })
        : callReportOps("saveReport", base);

      const res = await req;
      wx.hideLoading();
      if (res.result && res.result.success) {
        wx.showToast({ title: isEdit ? "已保存修改" : "已保存" });
        setTimeout(() => {
          if (isEdit) {
            // 返回详情页，详情页 onShow 会自动刷新
            wx.navigateBack();
          } else {
            wx.redirectTo({
              url: "/pages/report-detail/report-detail?id=" + res.result._id,
            });
          }
        }, 500);
      } else {
        wx.showToast({ title: (res.result && res.result.msg) || "保存失败", icon: "none" });
        this.setData({ saving: false });
      }
    } catch (e) {
      wx.hideLoading();
      console.error("保存报表失败", e);
      wx.showToast({ title: "保存失败，请检查云环境", icon: "none" });
      this.setData({ saving: false });
    }
  },
});
