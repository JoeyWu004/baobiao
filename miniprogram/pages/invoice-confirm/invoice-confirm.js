// pages/invoice-confirm/invoice-confirm.js 发票确认（逐张独立确认/记账）
const { db } = require("../../utils/cloud");
const { fmtMoney, roundMoney, fmtDate } = require("../../utils/format");
const recognition = require("../../utils/recognition");

Page({
  data: {
    invoices: [], // [{ supplier, date, fileID, items }]
    currentIndex: 0,
    saving: false,
  },

  async onLoad() {
    // 结果来自后台识别任务（recognitionJobs 最近一次完成的任务）
    const job = await recognition.getLatestFinished();
    if (job) recognition.confirmViewed(); // 标记已处理，清除「进货」角标
    const list = (job && job.results ? job.results : []).filter(Boolean);
    if (!list.length) {
      wx.showToast({ title: "没有待确认的发票数据", icon: "none" });
      setTimeout(() => wx.navigateBack(), 800);
      return;
    }
    this._uid = 0;
    const invoices = list.map((inv) => ({
      supplier: inv.supplier || "",
      date: inv.date || fmtDate(new Date()),
      fileID: inv.fileID || "",
      items: (inv.items || []).map((it) => ({
        uid: this.newUid(),
        name: it.name || "",
        unit: it.unit || "个",
        quantity: Number(it.quantity) || 0,
        price: Number(it.price) || 0,
      })),
    }));
    this.setData({ invoices });
    this.recalc();
    // 发票原图：一次性取所有 fileID 的临时链接，绑定到各张发票
    const fileIDs = invoices.map((inv) => inv.fileID).filter(Boolean);
    if (fileIDs.length) {
      wx.cloud
        .getTempFileURL({ fileList: fileIDs })
        .then((r) => {
          const map = {};
          (r.fileList || []).forEach((f) => {
            if (f && f.fileID && f.tempFileURL) map[f.fileID] = f.tempFileURL;
          });
          this.setData({
            invoices: this.data.invoices.map((inv) => ({
              ...inv,
              tempUrl: inv.fileID ? map[inv.fileID] || "" : "",
            })),
          });
        })
        .catch(() => {});
    }
  },

  newUid() {
    this._uid += 1;
    return "inv-" + this._uid;
  },

  ci() {
    return this.data.currentIndex;
  },

  // 上一张 / 下一张
  goPrev() {
    if (this.ci() > 0) this.setData({ currentIndex: this.ci() - 1 });
  },

  goNext() {
    if (this.ci() < this.data.invoices.length - 1) {
      this.setData({ currentIndex: this.ci() + 1 });
    }
  },

  previewImg(e) {
    const url = e.currentTarget.dataset.src;
    if (url) wx.previewImage({ urls: [url] });
  },

  onSupplierInput(e) {
    this.setData({ [`invoices[${this.ci()}].supplier`]: e.detail.value });
  },

  onDateChange(e) {
    this.setData({ [`invoices[${this.ci()}].date`]: e.detail.value });
  },

  onItemInput(e) {
    const field = e.currentTarget.dataset.field; // name | unit | quantity | price
    const index = Number(e.currentTarget.dataset.index);
    // 数量/单价保留原始字符串：立即 Number() 会吞掉输入中的小数点，导致无法输入小数
    this.setData({
      [`invoices[${this.ci()}].items[${index}].${field}`]: e.detail.value,
    });
    this.recalc();
  },

  addItem() {
    const ci = this.ci();
    const invoices = this.data.invoices.slice();
    invoices[ci] = {
      ...invoices[ci],
      items: [
        ...invoices[ci].items,
        { uid: this.newUid(), name: "", unit: "个", quantity: 1, price: 0 },
      ],
    };
    this.setData({ invoices });
    this.recalc();
  },

  removeItem(e) {
    const ci = this.ci();
    const index = Number(e.currentTarget.dataset.index);
    const invoices = this.data.invoices.slice();
    const items = invoices[ci].items.slice();
    items.splice(index, 1);
    invoices[ci] = { ...invoices[ci], items };
    this.setData({ invoices });
    this.recalc();
  },

  recalc() {
    const invoices = this.data.invoices.map((inv) => ({
      ...inv,
      items: inv.items.map((it) => {
        const amount = roundMoney(Number(it.price) * Number(it.quantity));
        return { ...it, amount, amountText: fmtMoney(amount) };
      }),
    }));
    this.setData({ invoices });
  },

  // 有效明细：名称非空且数量非负
  validRows(items) {
    return (items || []).filter(
      (it) => it.name && it.name.trim() && Number(it.quantity) >= 0
    );
  },

  // 有效发票：至少一行有效明细，且没有任何负数量行
  isValidInvoice(inv) {
    const items = inv.items || [];
    if (!items.some((it) => it.name && it.name.trim())) return false;
    return !items.some((it) => Number(it.quantity) < 0);
  },

  // 删除当前发票：丢弃识别结果（不入库），顺手清理已上传图片
  deleteCurrent() {
    const ci = this.ci();
    const inv = this.data.invoices[ci];
    if (!inv) return;
    wx.showModal({
      title: "删除这张发票",
      content: "识别结果将被丢弃（不会存入商品库/收支统计），无法恢复。",
      confirmColor: "#fa5151",
      success: (res) => {
        if (!res.confirm) return;
        if (inv.fileID) {
          wx.cloud.deleteFile({ fileList: [inv.fileID] }).catch(() => {});
        }
        const invoices = this.data.invoices.slice();
        invoices.splice(ci, 1);
        this.setData({
          invoices,
          currentIndex: Math.min(ci, invoices.length - 1),
        });
        if (invoices.length === 0) {
          wx.showToast({ title: "已删除，没有剩余发票" });
          setTimeout(() => wx.navigateBack(), 700);
        } else {
          wx.showToast({ title: "已删除" });
        }
      },
    });
  },

  // 有效发票一键入库：只处理有效发票，无效的留在列表里供删除/修改
  async saveToGoods() {
    const entries = [];
    const skipped = [];
    this.data.invoices.forEach((inv, idx) => {
      if (this.isValidInvoice(inv)) entries.push({ idx, inv });
      else skipped.push(idx);
    });
    if (!entries.length) {
      wx.showToast({ title: "没有有效发票可入库", icon: "none" });
      return;
    }
    this.setData({ saving: true });
    wx.showLoading({ title: "入库中…", mask: true });
    const done = [];
    try {
      for (const { idx, inv } of entries) {
        await this.saveOneInvoice(inv);
        done.push(idx);
      }
    } catch (e) {
      console.error("入库失败", e);
    }
    wx.hideLoading();
    // 移除已入库的，保留无效/失败的
    const invoices = this.data.invoices.slice();
    done.sort((a, b) => b - a).forEach((idx) => invoices.splice(idx, 1));
    this.setData({
      invoices,
      currentIndex: Math.min(this.data.currentIndex, invoices.length - 1),
      saving: false,
    });
    const doneCount = done.length;
    const failCount = entries.length - doneCount;
    let msg = `已入库 ${doneCount} 张`;
    if (skipped.length) msg += `，跳过 ${skipped.length} 张无效`;
    if (failCount) msg += `，${failCount} 张入库失败`;
    wx.showToast({ title: msg, icon: "none" });
    if (invoices.length === 0) {
      setTimeout(() => wx.navigateBack(), 900);
    }
  },

  // 单张发票：入库 + 进货记录（只处理有效明细行）
  async saveOneInvoice(inv) {
    const rows = this.validRows(inv.items);
    if (!rows.length) return;
    const supplier = (inv.supplier || "").trim();
    const date = inv.date || fmtDate(new Date());

    // 先建进货记录，拿到 purchaseId，供新建商品记录来源
    const items = rows.map((it) => ({
      name: it.name.trim(),
      unit: it.unit || "个",
      quantity: Number(it.quantity) || 0,
      price: roundMoney(Number(it.price) || 0),
      amount: roundMoney(Number(it.price || 0) * Number(it.quantity || 0)),
    }));
    const totalAmount = roundMoney(items.reduce((s, it) => s + it.amount, 0));
    const purchaseRes = await db().collection("purchases").add({
      data: {
        date,
        supplier,
        totalAmount,
        itemCount: items.length,
        items,
        invoiceCount: 1,
        fileID: inv.fileID || "",
        createTime: db().serverDate(),
      },
    });
    const purchaseId = purchaseRes._id;

    for (const it of rows) {
      const name = it.name.trim();
      const unitName = (it.unit || "").trim() || "个";
      const costPrice = roundMoney(Number(it.price) || 0);
      const qtyAdd = roundMoney(Number(it.quantity) || 0);
      const found = await db()
        .collection("products")
        .where({ name })
        .limit(1)
        .get();
      if (found.data.length > 0 && !found.data[0].deleted) {
        const p = found.data[0];
        const units = Array.isArray(p.units) && p.units.length
          ? p.units.slice()
          : [{ name: p.unit || "个", costPrice: p.costPrice || 0, sellPrice: p.sellPrice || 0, quantity: p.quantity || 0 }];
        const idx = units.findIndex((u) => u.name === unitName);
        if (idx >= 0) {
          const oldCost = Number(units[idx].costPrice || 0);
          if (Math.abs(oldCost - costPrice) > 0.001) {
            units[idx] = { ...units[idx], costPrice };
            await db().collection("priceHistory").add({
              data: {
                productId: p._id, productName: p.name, priceType: "cost",
                oldPrice: oldCost, newPrice: costPrice, unit: unitName,
                changeTime: db().serverDate(),
              },
            });
          }
          if (qtyAdd > 0) {
            const after = roundMoney(Number(units[idx].quantity || 0) + qtyAdd);
            units[idx] = { ...units[idx], quantity: after };
          }
        } else {
          // 新增单位：首次设定进价也算一次价格动作
          units.push({ name: unitName, costPrice, sellPrice: 0, quantity: qtyAdd });
          if (costPrice > 0) {
            await db().collection("priceHistory").add({
              data: {
                productId: p._id, productName: p.name, priceType: "cost",
                oldPrice: 0, newPrice: costPrice, unit: unitName,
                changeTime: db().serverDate(),
              },
            });
          }
        }
        const updateData = { units, supplier, updateTime: db().serverDate() };
        if (units[0].name === unitName) {
          updateData.unit = unitName;
          updateData.costPrice = Number(units[0].costPrice || 0);
          updateData.quantity = Number(units[0].quantity || 0);
        }
        await db().collection("products").doc(p._id).update({ data: updateData });
        if (qtyAdd > 0) {
          const target = units.find((u) => u.name === unitName);
          await db().collection("quantityHistory").add({
            data: {
              productId: p._id, productName: p.name, delta: qtyAdd,
              after: target ? target.quantity : qtyAdd, source: "invoice",
              unit: unitName, reportId: null, changeTime: db().serverDate(),
            },
          });
        }
      } else {
        const unit = { name: unitName, costPrice, sellPrice: 0, quantity: qtyAdd };
        const addRes = await db().collection("products").add({
          data: {
            name, units: [unit], unit: unitName, costPrice, sellPrice: 0,
            quantity: qtyAdd, supplier, categoryPath: [], remark: "",
            source: { type: "invoice", purchaseId, date, supplier },
            createTime: db().serverDate(), updateTime: db().serverDate(),
          },
        });
        // 新建商品：首次进价也算一次价格动作
        if (costPrice > 0) {
          await db().collection("priceHistory").add({
            data: {
              productId: addRes._id, productName: name, priceType: "cost",
              oldPrice: 0, newPrice: costPrice, unit: unitName,
              changeTime: db().serverDate(),
            },
          });
        }
        if (qtyAdd > 0) {
          await db().collection("quantityHistory").add({
            data: {
              productId: addRes._id, productName: name, delta: qtyAdd,
              after: qtyAdd, source: "invoice", unit: unitName,
              reportId: null, changeTime: db().serverDate(),
            },
          });
        }
      }
    }

  },

  // 入库并切下一张：只处理当前这张，存完从列表移除并跳到下一张
  async saveCurrentAndNext() {
    const inv = this.data.invoices[this.ci()];
    if (!inv) return;
    if (!this.isValidInvoice(inv)) {
      wx.showToast({ title: "该发票没有有效明细，无法入库", icon: "none" });
      return;
    }
    this.setData({ saving: true });
    wx.showLoading({ title: "入库中…", mask: true });
    try {
      await this.saveOneInvoice(inv);
      wx.hideLoading();
      const ci = this.ci();
      const invoices = this.data.invoices.slice();
      invoices.splice(ci, 1);
      this.setData({
        invoices,
        currentIndex: Math.min(ci, invoices.length - 1),
        saving: false,
      });
      if (invoices.length === 0) {
        wx.showToast({ title: "已全部入库" });
        setTimeout(() => wx.navigateBack(), 700);
      } else {
        wx.showToast({ title: "已入库，继续下一张" });
      }
    } catch (e) {
      wx.hideLoading();
      this.setData({ saving: false });
      console.error("入库失败", e);
      wx.showToast({ title: "入库失败", icon: "none" });
    }
  },
});
