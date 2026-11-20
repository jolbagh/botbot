const API = `https://api.telegram.org/bot${process.env.BOT_TOKEN}`;
const DB = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_IDS = (process.env.ADMIN_IDS || "").split(",").map(x => x.trim()).filter(Boolean);

async function tg(method, body) {
  const r = await fetch(`${API}/${method}`, {method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(body)});
  const j = await r.json();
  if (!j.ok) console.error("Telegram API:", method, j);
  return j;
}
async function db(path, opts={}) {
  const r = await fetch(`${DB}/rest/v1/${path}`, {
    method: opts.method || "GET",
    headers: {
      apikey: KEY, authorization: `Bearer ${KEY}`,
      "content-type":"application/json",
      "prefer": opts.prefer || "return=representation",
      ...(opts.headers || {})
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const t = await r.text();
  let j; try { j= t ? JSON.parse(t) : null; } catch { j=t; }
  if (!r.ok) throw new Error(`DB ${r.status}: ${JSON.stringify(j)}`);
  return j;
}
const isAdmin = id => ADMIN_IDS.includes(String(id));
const enc = s => encodeURIComponent(s);
async function state(id) {
  const rows = await db(`user_states?user_id=eq.${id}&select=*`);
  return rows[0] || null;
}
async function setState(id, data) {
  await db("user_states?on_conflict=user_id", {method:"POST", prefer:"resolution=merge-duplicates,return=minimal", body:{user_id:id,...data}});
}
async function clearState(id) {
  await db(`user_states?user_id=eq.${id}`, {method:"DELETE", prefer:"return=minimal"});
}
async function user(id, username, first_name) {
  await db("users?on_conflict=telegram_id", {method:"POST", prefer:"resolution=merge-duplicates,return=minimal", body:{telegram_id:id, username:username||null, first_name:first_name||null}});
}
async function msg(chat_id, text, reply_markup) {
  return tg("sendMessage",{chat_id,text,parse_mode:"HTML",reply_markup});
}
async function mainMenu(id, chat_id) {
  const plans = await db("plans?active=eq.true&select=id,name,price_toman&order=sort_order.asc");
  const custom = await db("custom_buttons?active=eq.true&select=id,label,kind,payload&order=sort_order.asc");
  const rows = [];
  for (const p of plans) rows.push([{text:`🛒 ${p.name} — ${Number(p.price_toman).toLocaleString("fa-IR")} تومان`,callback_data:`buy:${p.id}`}]);
  rows.push([{text:"💰 افزایش موجودی",callback_data:"deposit"},{text:"👤 حساب من",callback_data:"account"}]);
  rows.push([{text:"📞 پشتیبانی",callback_data:"support"}]);
  for (const b of custom) rows.push([{text:b.label,callback_data:`custom:${b.id}`}]);
  if (isAdmin(id)) rows.push([{text:"⚙️ پنل مدیریت",callback_data:"admin"}]);
  return msg(chat_id,"به فروشگاه کانفیگ خوش آمدید.\nیکی از گزینه‌ها را انتخاب کنید:",{inline_keyboard:rows});
}
async function adminMenu(chat_id) {
  return msg(chat_id,"⚙️ <b>پنل مدیریت</b>\nیک بخش را انتخاب کنید:",{inline_keyboard:[
    [{text:"➕ افزودن پلن",callback_data:"a:addplan"},{text:"📦 مدیریت پلن‌ها",callback_data:"a:plans"}],
    [{text:"➕ افزودن کانفیگ به پلن",callback_data:"a:addstock"}],
    [{text:"🧩 مدیریت دکمه‌های منو",callback_data:"a:buttons"}],
    [{text:"💳 تنظیم شماره کارت",callback_data:"a:payment"}],
    [{text:"💸 درخواست‌های پرداخت",callback_data:"a:deposits"}],
    [{text:"👥 کاربران و آمار",callback_data:"a:stats"}],
    [{text:"🏠 منوی اصلی",callback_data:"home"}]
  ]});
}
async function callback(q) {
  const id=q.from.id, chat=q.message.chat.id, data=q.data;
  await tg("answerCallbackQuery",{callback_query_id:q.id});
  if (data==="home") return mainMenu(id,chat);
  if (data==="admin") return isAdmin(id) ? adminMenu(chat) : msg(chat,"دسترسی غیرمجاز.");
  if (data==="deposit") { await setState(id,{step:"deposit_amount"}); return msg(chat,"مبلغ موردنظر را به تومان وارد کنید (فقط عدد)."); }
  if (data==="account") {
    const u=(await db(`users?telegram_id=eq.${id}&select=*`))[0];
    const count=(await db(`orders?telegram_id=eq.${id}&select=id`)).length;
    return msg(chat,`👤 <b>حساب کاربری</b>\nآیدی: <code>${id}</code>\nموجودی: <b>${Number(u?.balance_toman||0).toLocaleString("fa-IR")} تومان</b>\nتعداد خرید: ${count}`,{inline_keyboard:[[{text:"🏠 بازگشت",callback_data:"home"}]]});
  }
  if (data==="support") {
    const settings=(await db("settings?select=*"))[0]||{};
    return msg(chat,settings.support_text||"برای پشتیبانی با مدیر ربات تماس بگیرید.",{inline_keyboard:[[{text:"🏠 بازگشت",callback_data:"home"}]]});
  }
  if (data.startsWith("buy:")) {
    const planId=data.split(":")[1];
    const result=await db("rpc/purchase_stock",{method:"POST",body:{p_telegram_id:id,p_plan_id:planId}});
    const row=Array.isArray(result)?result[0]:result;
    if (!row || !row.config_text) return msg(chat,"متأسفانه موجودی این پلن تمام شده یا موجودی کیف پول کافی نیست.");
    await msg(chat,`✅ خرید با موفقیت انجام شد.\n\n📦 ${row.plan_name}\n\n<pre>${escapeHtml(row.config_text)}</pre>\n\nاز خرید شما متشکریم.`);
    return;
  }
  if (data.startsWith("custom:")) {
    const bid=data.split(":")[1];
    const b=(await db(`custom_buttons?id=eq.${bid}&active=eq.true&select=*`))[0];
    if (!b) return msg(chat,"این گزینه در دسترس نیست.");
    if (b.kind==="url") return msg(chat,b.label,{inline_keyboard:[[{text:"باز کردن لینک",url:b.payload}]]});
    if (b.kind==="text") return msg(chat,b.payload||"");
    if (b.kind==="support") return callback({...q,data:"support"});
    if (b.kind==="plans") return mainMenu(id,chat);
    return msg(chat,b.payload||"");
  }
  if (data.startsWith("approve:") || data.startsWith("reject:")) {
    if (!isAdmin(id)) return msg(chat,"دسترسی غیرمجاز.");
    const [action,depositId]=data.split(":");
    const result=await db(`rpc/${action}_deposit`,{method:"POST",body:{p_deposit_id:depositId,p_admin_id:id}});
    const row=Array.isArray(result)?result[0]:result;
    if (!row || row.ok!==true) return msg(chat,"این درخواست قبلاً بررسی شده یا وجود ندارد.");
    await tg("editMessageReplyMarkup",{chat_id:chat,message_id:q.message.message_id,reply_markup:{inline_keyboard:[]}});
    await msg(chat,action==="approve"?"✅ پرداخت تأیید و کیف پول کاربر شارژ شد.":"❌ پرداخت رد شد.");
    return tg("sendMessage",{chat_id:row.telegram_id,text:action==="approve"?"✅ پرداخت شما تأیید شد و کیف پولتان شارژ شد.":"❌ پرداخت شما توسط مدیر رد شد."});
  }
  if (data.startsWith("a:")) {
    if (!isAdmin(id)) return msg(chat,"دسترسی غیرمجاز.");
    const action=data.slice(2);
    if (action==="addplan") { await setState(id,{step:"plan_name"}); return msg(chat,"نام پلن را بفرست. مثال: ۱۰۰ گیگابایت - ۶۰ روزه"); }
    if (action==="plans") {
      const ps=await db("plans?select=*&order=sort_order.asc");
      const rows=ps.map(p=>[{text:`${p.active?"🟢":"⚪"} ${p.name} | ${p.price_toman} تومان`,callback_data:`a:toggleplan:${p.id}`}]);
      rows.push([{text:"🏠 پنل مدیریت",callback_data:"admin"}]);
      return msg(chat,"برای فعال/غیرفعال کردن هر پلن روی آن بزن:",{inline_keyboard:rows});
    }
    if (action.startsWith("toggleplan:")) {
      const pid=action.split(":")[1], p=(await db(`plans?id=eq.${pid}&select=*`))[0];
      await db(`plans?id=eq.${pid}`,{method:"PATCH",body:{active:!p.active}});
      return callback({...q,data:"a:plans"});
    }
    if (action==="addstock") {
      const ps=await db("plans?active=eq.true&select=id,name");
      return msg(chat,"پلن مقصد را انتخاب کن:",{inline_keyboard:ps.map(p=>[{text:p.name,callback_data:`a:stockplan:${p.id}`}])});
    }
    if (action.startsWith("stockplan:")) {
      await setState(id,{step:"stock_configs",plan_id:action.split(":")[1]});
      return msg(chat,"کانفیگ‌ها را ارسال کن؛ هر کانفیگ در یک پیام جداگانه. برای پایان /done را بفرست.");
    }
    if (action==="buttons") {
      const bs=await db("custom_buttons?select=*&order=sort_order.asc");
      const rows=[];
      for (const b of bs) {
        rows.push([{text:`${b.active?"🟢":"⚪"} ${b.label}`,callback_data:`a:togglebutton:${b.id}`}]);
        rows.push([{text:"✏️ ویرایش",callback_data:`a:editbutton:${b.id}`},{text:"🗑 حذف",callback_data:`a:deletebutton:${b.id}`}]);
      }
      rows.push([{text:"➕ افزودن دکمه",callback_data:"a:addbutton"}],[{text:"🏠 پنل مدیریت",callback_data:"admin"}]);
      return msg(chat,"مدیریت دکمه‌ها (برای فعال/غیرفعال روی دکمه بزن):",{inline_keyboard:rows});
    }
    if (action.startsWith("togglebutton:")) {
      const bid=action.split(":")[1], b=(await db(`custom_buttons?id=eq.${bid}&select=*`))[0];
      await db(`custom_buttons?id=eq.${bid}`,{method:"PATCH",body:{active:!b.active}});
      return callback({...q,data:"a:buttons"});
    }
    if (action.startsWith("deletebutton:")) {
      const bid=action.split(":")[1];
      await db(`custom_buttons?id=eq.${bid}`,{method:"DELETE",prefer:"return=minimal"});
      return callback({...q,data:"a:buttons"});
    }
    if (action.startsWith("editbutton:")) {
      const bid=action.split(":")[1], b=(await db(`custom_buttons?id=eq.${bid}&select=*`))[0];
      await setState(id,{step:"button_edit_label",button_id:bid,draft_kind:b.kind});
      return msg(chat,`نام جدید دکمه «${b.label}» را بفرست:`);
    }
    if (action==="addbutton") {
      await setState(id,{step:"button_label"});
      return msg(chat,"نام دکمه را بفرست؛ می‌توانی ایموجی هم اضافه کنی.");
    }
    if (action==="payment") {
      await setState(id,{step:"payment_text"});
      return msg(chat,"متن اطلاعات پرداخت را بفرست. مثال:\nشماره کارت: 0000-0000-0000-0000\nبه نام: نام صاحب کارت");
    }
    if (action==="deposits") {
      const ds=await db("deposits?status=eq.pending&select=id,telegram_id,amount_toman,created_at&order=created_at.asc");
      return msg(chat,`درخواست‌های در انتظار: ${ds.length}\nرسیدها هنگام ثبت، همراه دکمه تأیید/رد برای مدیر ارسال می‌شوند.`,{inline_keyboard:[[{text:"بازگشت",callback_data:"admin"}]]});
    }
    if (action==="stats") {
      const us=await db("users?select=telegram_id"), ps=await db("plans?select=id"), stock=await db("stock?status=eq.available&select=id");
      return msg(chat,`👥 کاربران: ${us.length}\n📦 پلن‌ها: ${ps.length}\n🎟 کانفیگ‌های موجود: ${stock.length}`,{inline_keyboard:[[{text:"بازگشت",callback_data:"admin"}]]});
    }
  }
}
function escapeHtml(s="") { return String(s).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;"); }
async function textMessage(m) {
  const id=m.from.id, chat=m.chat.id, text=m.text||"";
  await user(id,m.from.username,m.from.first_name);
  if (text==="/start") { await clearState(id); return mainMenu(id,chat); }
  const st=await state(id);
  if (st?.step==="deposit_amount") {
    const amount=Number(text.replace(/[,\s]/g,""));
    if (!Number.isSafeInteger(amount)||amount<1000) return msg(chat,"مبلغ معتبر وارد کن (حداقل ۱۰۰۰ تومان).");
    const setting=(await db("settings?select=*"))[0]||{};
    const card=setting.payment_text||"اطلاعات کارت هنوز توسط مدیر تنظیم نشده است.";
    await setState(id,{step:"deposit_receipt",amount_toman:amount});
    return msg(chat,`مبلغ درخواستی: <b>${amount.toLocaleString("fa-IR")} تومان</b>\n\n${escapeHtml(card)}\n\nپس از انتقال وجه، تصویر رسید را همین‌جا ارسال کن.`);
  }
  if (st?.step==="deposit_receipt" && m.photo?.length) {
    const fileId=m.photo[m.photo.length-1].file_id;
    const rows=await db("deposits",{method:"POST",body:{telegram_id:id,amount_toman:st.amount_toman,receipt_file_id:fileId,status:"pending"}});
    await clearState(id);
    const d=rows[0];
    for (const admin of ADMIN_IDS) {
      await tg("sendPhoto",{chat_id:admin,photo:fileId,caption:`💳 درخواست افزایش موجودی\nآیدی عددی: ${id}\nمبلغ درخواستی: ${Number(st.amount_toman).toLocaleString("fa-IR")} تومان\nشناسه درخواست: ${d.id}`,reply_markup:{inline_keyboard:[[{text:"✅ تأیید",callback_data:`approve:${d.id}`},{text:"❌ رد",callback_data:`reject:${d.id}`}]]}});
    }
    return msg(chat,"رسید شما برای مدیر ارسال شد. پس از بررسی، نتیجه به شما اطلاع داده می‌شود.");
  }
  if (st?.step==="plan_name" && isAdmin(id)) {
    await setState(id,{step:"plan_volume",draft_name:text});
    return msg(chat,"حجم پلن را به گیگابایت وارد کن (فقط عدد).");
  }
  if (st?.step==="plan_volume" && isAdmin(id)) {
    const n=Number(text); if(!Number.isFinite(n)||n<=0) return msg(chat,"حجم نامعتبر است. فقط عدد مثبت وارد کن.");
    await setState(id,{...st,step:"plan_days",draft_volume:n});
    return msg(chat,"مدت اعتبار را به روز وارد کن.");
  }
  if (st?.step==="plan_days" && isAdmin(id)) {
    const n=Number(text); if(!Number.isInteger(n)||n<=0) return msg(chat,"تعداد روز نامعتبر است.");
    await setState(id,{...st,step:"plan_price",draft_days:n});
    return msg(chat,"قیمت پلن را به تومان وارد کن.");
  }
  if (st?.step==="plan_price" && isAdmin(id)) {
    const n=Number(text); if(!Number.isSafeInteger(n)||n<0) return msg(chat,"قیمت نامعتبر است.");
    await db("plans",{method:"POST",body:{name:st.draft_name,volume_gb:st.draft_volume,duration_days:st.draft_days,price_toman:n,active:true}});
    await clearState(id);
    return msg(chat,"✅ پلن با موفقیت ساخته شد.",{inline_keyboard:[[{text:"پنل مدیریت",callback_data:"admin"}]]});
  }
  if (st?.step==="stock_configs" && isAdmin(id)) {
    if (text==="/done") { await clearState(id); return msg(chat,"✅ ورود کانفیگ‌ها تمام شد.",{inline_keyboard:[[{text:"پنل مدیریت",callback_data:"admin"}]]}); }
    await db("stock",{method:"POST",body:{plan_id:st.plan_id,config_text:text.trim(),status:"available"}});
    return msg(chat,"✅ کانفیگ به موجودی اضافه شد. کانفیگ بعدی را بفرست یا /done.");
  }
  if (st?.step==="button_label" && isAdmin(id)) {
    await setState(id,{step:"button_kind",draft_label:text});
    return msg(chat,"نوع دکمه را انتخاب کن:",{inline_keyboard:[
      [{text:"پیام متنی",callback_data:"a:buttonkind:text"},{text:"لینک",callback_data:"a:buttonkind:url"}],
      [{text:"نمایش پلن‌ها",callback_data:"a:buttonkind:plans"},{text:"پشتیبانی",callback_data:"a:buttonkind:support"}]
    ]});
  }
  if (st?.step==="button_payload" && isAdmin(id)) {
    await db("custom_buttons",{method:"POST",body:{label:st.draft_label,kind:st.draft_kind,payload:text,active:true}});
    await clearState(id);
    return msg(chat,"✅ دکمه جدید ساخته شد.",{inline_keyboard:[[{text:"مدیریت دکمه‌ها",callback_data:"a:buttons"}]]});
  }
  if (st?.step==="button_edit_label" && isAdmin(id)) {
    await setState(id,{...st,step:"button_edit_payload",draft_label:text});
    return msg(chat,"متن پاسخ یا محتوای جدید دکمه را بفرست:");
  }
  if (st?.step==="button_edit_payload" && isAdmin(id)) {
    await db(`custom_buttons?id=eq.${st.button_id}`,{method:"PATCH",body:{label:st.draft_label,payload:text}});
    await clearState(id);
    return msg(chat,"✅ نام و محتوای دکمه ویرایش شد.",{inline_keyboard:[[{text:"مدیریت دکمه‌ها",callback_data:"a:buttons"}]]});
  }
  if (st?.step==="payment_text" && isAdmin(id)) {
    await db("settings?on_conflict=id",{method:"POST",prefer:"resolution=merge-duplicates,return=minimal",body:{id:1,payment_text:text}});
    await clearState(id);
    return msg(chat,"✅ اطلاعات پرداخت ذخیره شد.",{inline_keyboard:[[{text:"پنل مدیریت",callback_data:"admin"}]]});
  }
  if (m.photo && st?.step==="deposit_receipt") return msg(chat,"لطفاً تصویر رسید را به‌صورت عکس ارسال کن.");
  if (isAdmin(id) && text==="/admin") return adminMenu(chat);
  return msg(chat,"برای شروع /start را بزن.");
}
export default async (req) => {
  if (req.method!=="POST") return new Response("OK",{status:200});
  try {
    const update=await req.json();
    if (update.callback_query) {
      const q=update.callback_query;
      if (q.data?.startsWith("a:buttonkind:")) {
        const id=q.from.id, kind=q.data.split(":")[2], st=await state(id);
        if (!isAdmin(id)||!st||st.step!=="button_kind") return new Response("OK");
        await setState(id,{...st,step:["plans","support"].includes(kind)?"button_payload":"button_payload",draft_kind:kind});
        await tg("answerCallbackQuery",{callback_query_id:q.id});
        await msg(q.message.chat.id,kind==="url"?"آدرس لینک را ارسال کن:":kind==="text"?"متن پاسخ این دکمه را ارسال کن:":"متن توضیحی یا payload اختیاری را ارسال کن:");
      } else await callback(q);
    } else if (update.message) await textMessage(update.message);
    return new Response("OK",{status:200});
  } catch(e) {
    console.error(e);
    return new Response("Webhook error",{status:200});
  }
};
