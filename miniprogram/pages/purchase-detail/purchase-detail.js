// pages/purchase-detail/purchase-detail.js 进货明细
const { db } = require("../../utils/cloud");
const { fmtMoney, fmtDate, roundMoney } = require("../../utils/format");

Page({
  data: {
    purchase: null,
    items: [],
    totalText: "0.00",
    imageUrl: "",
    loading: true,
    saving: false,
  },

  onLoad(options) {
    this.purchaseId = options.id || "";
    this._uid = 0;
    this.load();
  },

  newUid() {
    this._uid += 1;
    return "p-" + this._uid;
  },

  async load() {
    if (!this.purchaseId) return;
    this.setData({ loading: true });
    try {
      const res = await db().collection("purchases").doc(this.purchaseId).get();
      const p = res.data;
      const items = (p.items || []).map((it) => {
        const quantity = Number(it.quantity) || 0;
        const price = Number(it.price) || 0;
        const amount = roundMoney(Number(it.amount) || price * quantity);
        return {
          uid: this.newUid(),
          name: it.name || "",
          unit: it.unit || "个",
          quantity,
          price,
          amount,
          amountText: fmtMoney(amount),
        };
      });
      this.setData({
        purchase: p,
        items,
        totalText: fmtMoney(p.totalAmount || items.reduce((s, it) => s + it.amount, 0)),
      });
      // 发票图片
      if (p.fileID) {
        wx.cloud
          .getTempFileURL({ fileList: [p.fileID] })
          .then((r) => {
            const f = r.fileList && r.fileList[0];
            if (f && f.tempFileURL) this.setData({ imageUrl: f.tempFileURL });
          })
          .catch(() => {});
      }
    } catch (e) {
      console.error("进货明细加载失败", e);
      wx.showToast({ title: "加载失败", icon: "none" });
    } finally {
      this.setData({ loading: false });
    }
  },

  previewImg(e) {
    const url = e.currentTarget.dataset.src;
    wx.previewImage({ urls: [url] });
  },

  // ---------- 编辑 ----------
  onSupplierInput(e) {
    this.setData({ "purchase.supplier": e.detail.value });
  },

  onDateChange(e) {
    this.setData({ "purchase.date": e.detail.value });
  },

  onItemInput(e) {
    const field = e.currentTarget.dataset.field; // name | unit | quantity | price
    const index = Number(e.currentTarget.dataset.index);
    const items = this.data.items.slice();
    const item = { ...items[index] };
    if (!item) return;
    // 数量/单价保留原始字符串：立即 Number() 会吞掉输入中的小数点，导致无法输入小数
    item[field] = e.detail.value;
    items[index] = item;
    this.setData({ items });
    this.recalc();
  },

  addItem() {
    this.setData({
      items: [
        ...this.data.items,
        { uid: this.newUid(), name: "", unit: "个", quantity: 1, price: 0, amount: 0 },
      ],
    });
    this.recalc();
  },

  removeItem(e) {
    const index = Number(e.currentTarget.dataset.index);
    const items = this.data.items.slice();
    items.splice(index, 1);
    this.setData({ items });
    this.recalc();
  },

  recalc() {
    const items = this.data.items.map((it) => {
      const amount = roundMoney(Number(it.price) * Number(it.quantity));
      return { ...it, amount, amountText: fmtMoney(amount) };
    });
    const total = roundMoney(items.reduce((s, it) => s + it.amount, 0));
    this.setData({ items, totalText: fmtMoney(total) });
  },

  // 按进货记录编辑前后明细，对商品库库存/进价做增量修正（只补差额，可重复编辑）
  async syncStock(oldItems, newItems, supplier) {
    const agg = (arr) => {
      const m = {};
      (arr || []).forEach((it) => {
        const name = (it.name || "").trim();
        if (!name) return;
        const unit = (it.unit || "").trim() || "个";
        const key = name + "" + unit;
        if (!m[key]) m[key] = { name, unit, qty: 0, price: 0 };
        m[key].qty = roundMoney(m[key].qty + (Number(it.quantity) || 0));
        m[key].price = roundMoney(Number(it.price) || 0);
      });
      return m;
    };
    const oldMap = agg(oldItems);
    const newMap = agg(newItems);
    const keys = [...new Set([...Object.keys(oldMap), ...Object.keys(newMap)])];

    for (const key of keys) {
      const [name, unitName] = key.split("");
      const old = oldMap[key] || { qty: 0, price: 0 };
      const now = newMap[key] || { qty: 0, price: 0 };
      const delta = roundMoney(now.qty - old.qty);
      const priceChanged = now.price > 0 && Math.abs(now.price - old.price) > 0.001;

      const found = await db().collection("products").where({ name }).limit(1).get();
      let product = found.data[0];
      // 已删除（回收站）的商品视为不存在，重新建档
      if (product && product.deleted) product = null;

      // 商品不存在：编辑后仍有数量就新建
      if (!product) {
        if (now.qty > 0) {
          const addRes = await db().collection("products").add({
            data: {
              name,
              units: [{ name: unitName, costPrice: now.price, sellPrice: 0, quantity: now.qty }],
              unit: unitName,
              costPrice: now.price,
              sellPrice: 0,
              quantity: now.qty,
              supplier,
              categoryPath: [],
              remark: "",
              createTime: db().serverDate(),
              updateTime: db().serverDate(),
            },
          });
          await db().collection("quantityHistory").add({
            data: {
              productId: addRes._id, productName: name, delta: now.qty,
              after: now.qty, source: "purchase-edit", unit: unitName,
              reportId: null, changeTime: db().serverDate(),
            },
          });
        }
        // 新建商品：首次进价也算一次价格动作
        if (now.price > 0) {
          await db().collection("priceHistory").add({
            data: {
              productId: addRes._id, productName: name, priceType: "cost",
              oldPrice: 0, newPrice: now.price, unit: unitName,
              changeTime: db().serverDate(),
            },
          });
        }
        continue;
      }

      let units = Array.isArray(product.units) && product.units.length
        ? product.units.slice()
        : [{ name: product.unit || "个", costPrice: product.costPrice || 0, sellPrice: product.sellPrice || 0, quantity: product.quantity || 0 }];
      let idx = units.findIndex((u) => u.name === unitName);
      let changed = false;

      if (idx < 0) {
        // 该商品下新增单位
        if (delta !== 0 || now.qty > 0) {
          units.push({ name: unitName, costPrice: now.price || 0, sellPrice: 0, quantity: now.qty });
          idx = units.length - 1;
          changed = true;
          // 新增单位：首次进价也算一次价格动作
          if (now.price > 0) {
            await db().collection("priceHistory").add({
              data: {
                productId: product._id, productName: name, priceType: "cost",
                oldPrice: 0, newPrice: now.price, unit: unitName,
                changeTime: db().serverDate(),
              },
            });
          }
          if (now.qty > 0) {
            await db().collection("quantityHistory").add({
              data: {
                productId: product._id, productName: name, delta: now.qty,
                after: now.qty, source: "purchase-edit", unit: unitName,
                reportId: null, changeTime: db().serverDate(),
              },
            });
          }
        }
      } else {
        const unit = { ...units[idx] };
        // 数量差额
        if (delta !== 0) {
          const before = roundMoney(Number(unit.quantity || 0));
          const after = roundMoney(before + delta); // 库存允许为负
          const appliedDelta = roundMoney(after - before);
          if (appliedDelta !== 0) {
            unit.quantity = after;
            units[idx] = unit;
            changed = true;
            await db().collection("quantityHistory").add({
              data: {
                productId: product._id, productName: name, delta: appliedDelta,
                after, source: "purchase-edit", unit: unitName,
                reportId: null, changeTime: db().serverDate(),
              },
            });
          }
        }
        // 进价修正：仅当商品当前成本价仍是旧进价（即本记录是定价来源）才覆盖
        if (priceChanged && Math.abs(Number(unit.costPrice || 0) - old.price) < 0.001) {
          const oldPrice = Number(unit.costPrice || 0);
          const newPrice = now.price;
          unit.costPrice = newPrice;
          units[idx] = unit;
          changed = true;
          await db().collection("priceHistory").add({
            data: {
              productId: product._id, productName: name, priceType: "cost",
              oldPrice, newPrice, unit: unitName, changeTime: db().serverDate(),
            },
          });
        }
      }

      if (changed) {
        const updateData = { units, supplier, updateTime: db().serverDate() };
        if (units[0].name === unitName) {
          updateData.unit = units[0].name;
          updateData.costPrice = Number(units[0].costPrice || 0);
          updateData.quantity = Number(units[0].quantity || 0);
        }
        await db().collection("products").doc(product._id).update({ data: updateData });
      }
    }
  },

  // 保存修改：同步修正商品库库存/进价后，更新 purchases 记录
  async onSave() {
    const { items, purchase } = this.data;
    if (!items.length) {
      wx.showToast({ title: "请至少保留一行明细", icon: "none" });
      return;
    }
    for (let i = 0; i < items.length; i++) {
      if (!items[i].name.trim()) {
        wx.showToast({ title: `第 ${i + 1} 行缺少商品名称`, icon: "none" });
        return;
      }
      if (Number(items[i].quantity) < 0) {
        wx.showToast({ title: `第 ${i + 1} 行数量不能为负数`, icon: "none" });
        return;
      }
    }
    const payloadItems = items.map((it) => ({
      name: it.name.trim(),
      unit: it.unit.trim() || "个",
      quantity: Number(it.quantity) || 0,
      price: roundMoney(Number(it.price) || 0),
      amount: roundMoney(Number(it.price || 0) * Number(it.quantity || 0)),
    }));
    const totalAmount = roundMoney(payloadItems.reduce((s, it) => s + it.amount, 0));
    const supplier = (purchase.supplier || "").trim();
    this.setData({ saving: true });
    wx.showLoading({ title: "保存中…" });
    try {
      // 以数据库当前明细为基线做库存对账（支持同一记录多次编辑）
      const oldRes = await db().collection("purchases").doc(this.purchaseId).get();
      const oldItems = (oldRes.data.items || []).map((it) => ({
        name: it.name || "",
        unit: it.unit || "个",
        quantity: Number(it.quantity) || 0,
        price: Number(it.price) || 0,
      }));
      await this.syncStock(oldItems, payloadItems, supplier);
      await db()
        .collection("purchases")
        .doc(this.purchaseId)
        .update({
          data: {
            supplier,
            date: purchase.date || fmtDate(new Date()),
            items: payloadItems,
            totalAmount,
            itemCount: payloadItems.length,
            updateTime: db().serverDate(),
          },
        });
      wx.hideLoading();
      this.setData({ saving: false });
      wx.showToast({ title: "已保存并修正库存" });
    } catch (e) {
      wx.hideLoading();
      this.setData({ saving: false });
      console.error("保存失败", e);
      wx.showToast({ title: "保存失败", icon: "none" });
    }
  },

  // 用它开报表：把当前明细带过去开新报表
  openReport() {
    const goodsItems = (this.data.items || [])
      .filter((it) => it.name && it.name.trim())
      .map((it) => ({
        type: "goods",
        name: it.name.trim(),
        unit: it.unit || "个",
        price: Number(it.price) || 0,
        quantity: Number(it.quantity) || 0,
      }));
    if (!goodsItems.length) {
      wx.showToast({ title: "没有可用的明细", icon: "none" });
      return;
    }
    getApp().globalData.reportDraft = {
      items: goodsItems,
      date: (this.data.purchase && this.data.purchase.date) || "",
    };
    wx.navigateTo({ url: "/pages/report-edit/report-edit" });
  },
});
