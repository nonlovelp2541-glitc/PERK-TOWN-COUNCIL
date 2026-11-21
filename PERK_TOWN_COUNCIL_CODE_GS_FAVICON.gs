const SPREADSHEET_ID = '1eNsB0sa5TC6OZiGbSqy8erxDosj05dgXyfms3GeaCZ4';
const TOKEN_TTL = 21600;
const SHEETS = {
  SETTINGS: 'SETTINGS',
  CATEGORIES: 'CATEGORIES',
  RULES: 'RULES',
  NEWS: 'NEWS',
  MEMBERS: 'MEMBERS',
  USERS: 'USERS',
  LOGS: 'LOGS',
  RULE_DRAFTS: 'RULE_DRAFTS',
  RULE_HISTORY: 'RULE_HISTORY'
};

function doGet(e) {
  setupDatabase_();
  let oauthResult = null;
  const params = (e && e.parameter) || {};
  if (params.code || params.error) {
    try {
      if (params.error) throw new Error('Discord ไม่อนุญาตการเข้าสู่ระบบ: ' + params.error);
      oauthResult = completeDiscordLogin_(params.code, params.state);
    } catch (err) {
      oauthResult = { ok: false, message: err.message || String(err) };
    }
  }
  const template = HtmlService.createTemplateFromFile('index');
  template.oauthResultJson = JSON.stringify(oauthResult).replace(/</g, '\\u003c');
  return template.evaluate()
    .setFaviconUrl('https://image.perktown.pro/LQNBrjcx.webp')
    .setTitle('PERK TOWN | OFFICIAL COUNTRY PORTAL')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// เริ่มต้น Discord OAuth2 โดยสร้าง state ป้องกันการปลอมคำขอ
function getDiscordAuthUrl() {
  const props = PropertiesService.getScriptProperties();
  const clientId = props.getProperty('DISCORD_CLIENT_ID') || '1570733206934650990';
  if (!props.getProperty('DISCORD_CLIENT_SECRET')) {
    throw new Error('ยังไม่ได้ตั้งค่า DISCORD_CLIENT_SECRET ใน Script Properties');
  }
  // ระบบนี้เป็นหลังบ้านของสภา: ใช้ยศ Council ไม่บังคับยศ Admin
  const councilRoleId = props.getProperty('DISCORD_COUNCIL_ROLE_ID') || '1531417232783966358';
  if (!councilRoleId) {
    throw new Error('ไม่พบ Role ID ของยศ Council กรุณาตั้งค่า DISCORD_COUNCIL_ROLE_ID');
  }
  const state = Utilities.getUuid() + Utilities.getUuid();
  CacheService.getScriptCache().put('PTC_OAUTH_STATE_' + state, '1', 600);
  const redirectUri = ScriptApp.getService().getUrl();
  const scopes = 'identify guilds.members.read';
  const url = 'https://discord.com/oauth2/authorize?' + [
    'client_id=' + encodeURIComponent(clientId),
    'response_type=code',
    'redirect_uri=' + encodeURIComponent(redirectUri),
    'scope=' + encodeURIComponent(scopes),
    'state=' + encodeURIComponent(state),
    'prompt=consent'
  ].join('&');
  return url;
}

// แลก authorization code และตรวจสอบสมาชิก/ยศ Council ที่ฝั่งเซิร์ฟเวอร์เท่านั้น
function completeDiscordLogin_(code, state) {
  if (!code || !state) throw new Error('ข้อมูลยืนยันตัวตนจาก Discord ไม่ครบ');
  const cache = CacheService.getScriptCache();
  const stateKey = 'PTC_OAUTH_STATE_' + state;
  if (!cache.get(stateKey)) throw new Error('คำขอเข้าสู่ระบบหมดอายุหรือไม่ถูกต้อง กรุณาลองใหม่');
  cache.remove(stateKey);

  const props = PropertiesService.getScriptProperties();
  const clientId = props.getProperty('DISCORD_CLIENT_ID') || '1570733206934650990';
  const clientSecret = props.getProperty('DISCORD_CLIENT_SECRET');
  if (!clientSecret) throw new Error('ผู้ดูแลยังไม่ได้ตั้งค่า Discord Client Secret');
  const redirectUri = ScriptApp.getService().getUrl();

  const tokenResponse = UrlFetchApp.fetch('https://discord.com/api/oauth2/token', {
    method: 'post',
    payload: {
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: redirectUri
    },
    muteHttpExceptions: true
  });
  const tokenData = JSON.parse(tokenResponse.getContentText() || '{}');
  if (tokenResponse.getResponseCode() !== 200 || !tokenData.access_token) {
    throw new Error('Discord แลก Token ไม่สำเร็จ กรุณาตรวจสอบ Client Secret และ Redirect URI');
  }

  const headers = { Authorization: 'Bearer ' + tokenData.access_token };
  const meResponse = UrlFetchApp.fetch('https://discord.com/api/users/@me', { headers, muteHttpExceptions: true });
  const me = JSON.parse(meResponse.getContentText() || '{}');
  if (meResponse.getResponseCode() !== 200 || !me.id) throw new Error('ไม่สามารถอ่านข้อมูลบัญชี Discord ได้');

  const guildId = props.getProperty('DISCORD_GUILD_ID') || '1305283019900194836';
  // ยืนยันยศ Council โดยตรง ไม่ใช้ DISCORD_ADMIN_ROLE_ID
  const councilRoleId = props.getProperty('DISCORD_COUNCIL_ROLE_ID') || '1531417232783966358';
  if (!councilRoleId) throw new Error('ไม่พบ Role ID ของยศ Council');
  const memberResponse = UrlFetchApp.fetch('https://discord.com/api/users/@me/guilds/' + guildId + '/member', {
    headers: headers,
    muteHttpExceptions: true
  });
  const member = JSON.parse(memberResponse.getContentText() || '{}');
  if (memberResponse.getResponseCode() !== 200) {
    if (memberResponse.getResponseCode() === 404) throw new Error('บัญชีนี้ไม่ได้เป็นสมาชิกเซิร์ฟเวอร์ PERK TOWN');
    throw new Error('ตรวจสอบสมาชิก Discord ไม่สำเร็จ กรุณาตรวจสอบ OAuth2 Scope guilds.members.read');
  }
  const roles = Array.isArray(member.roles) ? member.roles.map(String) : [];
  if (roles.indexOf(String(councilRoleId)) === -1) {
    throw new Error('ไม่อนุญาตให้เข้าใช้งาน เฉพาะสมาชิกที่มียศ Council ของ PERK TOWN เท่านั้น');
  }

  const displayName = String(me.global_name || me.username || 'PERK TOWN Council');
  const sessionToken = Utilities.getUuid() + Utilities.getUuid();
  // ใช้ namespace token เดิมเพื่อให้ auth_ และฟังก์ชันหลังบ้านเดิมทำงานต่อได้
  cache.put('PTC_ADMIN_TOKEN_' + sessionToken, JSON.stringify({
    username: displayName,
    discordId: String(me.id),
    role: 'COUNCIL'
  }), TOKEN_TTL);
  log_(displayName + ' (' + me.id + ')', 'เข้าสู่ระบบหลังบ้านสภาผ่าน Discord ด้วยยศ Council');
  return { ok: true, token: sessionToken, username: displayName, role: 'COUNCIL' };
}


function db_() {
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

function sheet_(name, headers) {
  const ss = db_();
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0 && headers && headers.length) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
  }
  return sh;
}

function setupDatabase_() {
  const ss = db_();
  const settings = sheet_(SHEETS.SETTINGS, ['key', 'value']);
  sheet_(SHEETS.CATEGORIES, ['id', 'icon', 'name', 'desc']);
  const ruleSheet = sheet_(SHEETS.RULES, ['id', 'title', 'category', 'body', 'updatedAt', 'changeNote']);
   const ruleHeaders = ruleSheet.getRange(1, 1, 1, Math.max(4, ruleSheet.getLastColumn())).getValues()[0];
   if (ruleHeaders.indexOf('updatedAt') < 0) ruleSheet.getRange(1, 5).setValue('updatedAt');
   if (ruleHeaders.indexOf('changeNote') < 0) ruleSheet.getRange(1, 6).setValue('changeNote');
  sheet_(SHEETS.NEWS, ['id', 'title', 'date', 'body']);
  sheet_(SHEETS.MEMBERS, ['id', 'name', 'role', 'desc']);
  sheet_(SHEETS.USERS, ['username', 'salt', 'hash', 'role', 'active']);
  sheet_(SHEETS.LOGS, ['at', 'by', 'action']);
  sheet_(SHEETS.RULE_DRAFTS, ['draftId','ruleId','title','category','body','changeNote','submittedBy','submittedAt','status']);
  sheet_(SHEETS.RULE_HISTORY, ['at','by','ruleId','ruleTitle','action','beforeTitle','beforeCategory','beforeBody','afterTitle','afterCategory','afterBody','changeNote']);

  if (settings.getLastRow() < 2) {
    settings.getRange(2, 1, 4, 2).setValues([
      ['title', 'ศูนย์ข้อมูลประเทศ'],
      ['subtitle', 'ข้อมูลกลางแห่งประเทศ PERK TOWN'],
      ['description', 'ศูนย์รวมกฎระเบียบ ประกาศ หน่วยงาน แก๊ง MC Family สวัสดิการ และข้อมูลสำคัญของประเทศ PERK TOWN'],
      ['duty', 'เปิดให้ผู้เล่นเข้าถึงข้อมูลได้ตลอด 24 ชั่วโมง']
    ]);
  }
  const cats = sheet_(SHEETS.CATEGORIES);
  if (cats.getLastRow() < 2) {
    cats.getRange(2, 1, 8, 4).setValues([
      ['rules','⚖','กฎระเบียบประเทศ','ข้อบังคับและแนวทางสำหรับผู้เล่นทุกคน'],
      ['penalties','▣','บทลงโทษ / BLACKLIST','หลักเกณฑ์การลงโทษและประวัติการกระทำผิด'],
      ['gangs','♜','แก๊ง / MC / Family','กฎการจัดตั้ง การดูแล และการดำเนินกิจกรรม'],
      ['agencies','▦','หน่วยงานประเทศ','โครงสร้างหน้าที่และช่องทางติดต่อหน่วยงาน'],
      ['economy','◇','ระบบเศรษฐกิจ','การเงิน ค่าตอบแทน และกิจกรรมภายในประเทศ'],
      ['welfare','♧','สวัสดิการ','สิทธิประโยชน์และเงื่อนไขการรับสวัสดิการ'],
      ['apply','✦','สมัครและลงทะเบียน','คุณสมบัติ ขั้นตอน และแบบฟอร์มที่เกี่ยวข้อง'],
      ['guide','▤','คู่มือผู้เล่น','แนวทางการใช้งานและการอยู่ร่วมกันในประเทศ']
    ]);
  }
  const rules = sheet_(SHEETS.RULES);
  if (rules.getLastRow() < 2) {
    rules.getRange(2, 1, 9, 4).setValues([
      ['R-01','กฎพื้นฐานของประเทศ PERK TOWN','rules','ผู้เล่นทุกคนต้องเคารพกฎของประเทศ ใช้ถ้อยคำสุภาพ ไม่สร้างความเดือดร้อน และปฏิบัติต่อผู้อื่นอย่างเป็นธรรม'],
      ['P-01','หลักเกณฑ์การลงโทษและ BLACKLIST','penalties','การลงโทษต้องอ้างอิงกฎที่ประกาศใช้อย่างชัดเจน ตรวจสอบหลักฐาน และเปิดโอกาสให้ผู้เกี่ยวข้องชี้แจงตามขั้นตอน'],
      ['G-01','ข้อกำหนดสำหรับแก๊ง MC และ Family','gangs','กลุ่มทุกประเภทต้องลงทะเบียนตามขั้นตอน ปฏิบัติตามเงื่อนไขจำนวนสมาชิก กิจกรรม และข้อกำหนดที่ประเทศประกาศ'],
      ['A-01','หน้าที่ของหน่วยงานประเทศ','agencies','หน่วยงานต้องปฏิบัติงานตามขอบเขตหน้าที่ ประสานงานอย่างเป็นระบบ และให้บริการผู้เล่นด้วยความเป็นกลาง'],
      ['E-01','แนวทางระบบเศรษฐกิจประเทศ','economy','การรับเงิน รางวัล ค่าตอบแทน และธุรกรรมภายในประเทศให้ยึดตามประกาศและเงื่อนไขที่ผู้ดูแลกำหนด'],
      ['W-01','เงื่อนไขการรับสวัสดิการ','welfare','การรับสวัสดิการต้องเป็นไปตามคุณสมบัติ ระยะเวลา และหลักฐานที่ระบุในประกาศของประเทศ'],
      ['AP-01','ขั้นตอนการสมัครและลงทะเบียน','apply','ผู้สมัครต้องให้ข้อมูลที่ถูกต้องครบถ้วน ยอมรับกฎที่เกี่ยวข้อง และรอการตรวจสอบจากเจ้าหน้าที่ผู้รับผิดชอบ'],
      ['H-01','คู่มือการใช้งานสำหรับผู้เล่น','guide','ผู้เล่นควรศึกษาคู่มือและประกาศล่าสุดก่อนเข้าร่วมกิจกรรม หากมีข้อสงสัยให้ติดต่อหน่วยงานที่รับผิดชอบ'],
      ['C-01','การแจ้งเรื่องและข้อพิพาท','rules','การแจ้งเรื่องต้องระบุเหตุการณ์ วันเวลา ผู้เกี่ยวข้อง และแนบหลักฐานเท่าที่มี ห้ามแจ้งข้อมูลเท็จหรือกลั่นแกล้งผู้อื่น']
    ]);
  }
  const users = sheet_(SHEETS.USERS);
  if (users.getLastRow() < 2) {
    const salt = Utilities.getUuid();
    users.appendRow(['admin', salt, hash_('PTC@2026!', salt), 'SUPERADMIN', true]);
  }
}

function readRows_(name) {
  const sh = db_().getSheetByName(name);
  if (!sh || sh.getLastRow() < 2 || sh.getLastColumn() < 1) return [];
  const lastRow = sh.getLastRow();
  const lastCol = sh.getLastColumn();
  const values = sh.getRange(2, 1, lastRow - 1, lastCol).getValues();
  const headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  return values
    .filter(row => row.some(v => v !== '' && v !== null))
    .map(row => {
      const obj = {};
      headers.forEach((h, i) => {
        if (h !== '' && h !== null) obj[String(h)] = row[i] === null ? '' : row[i];
      });
      return obj;
    });
}

function writeRows_(name, headers, rows) {
  if (!Array.isArray(headers) || !headers.length) throw new Error('โครงสร้างหัวตารางไม่ถูกต้อง');
  if (!Array.isArray(rows)) throw new Error('รูปแบบข้อมูลที่บันทึกไม่ถูกต้อง');
  const sh = sheet_(name, headers);
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const last = sh.getLastRow();
    if (last > 1) sh.getRange(2, 1, last - 1, Math.max(sh.getLastColumn(), headers.length)).clearContent();
    if (rows.length) {
      const values = rows.map(obj => headers.map(h =>
        obj && obj[h] !== undefined && obj[h] !== null ? obj[h] : ''
      ));
      sh.getRange(2, 1, values.length, headers.length).setValues(values);
    }
  } finally {
    lock.releaseLock();
  }
}

function getPublicData() {
  setupDatabase_();
  const settings = {};
  readRows_(SHEETS.SETTINGS).forEach(r => {
    if (r && r.key !== undefined && r.key !== '') settings[String(r.key)] = r.value == null ? '' : r.value;
  });
  return {
    site: settings,
    categories: readRows_(SHEETS.CATEGORIES),
    rules: readRows_(SHEETS.RULES),
    news: readRows_(SHEETS.NEWS),
    members: readRows_(SHEETS.MEMBERS)
  };
}

function adminLogin(username, password) {
  // ปิดช่องทางล็อกอินแบบเดิม เพื่อไม่ให้ข้ามการตรวจสอบ Discord Council
  throw new Error('ระบบนี้ใช้การเข้าสู่ระบบผ่าน Discord และยศที่ได้รับอนุญาตเท่านั้น');
}

function adminGetData(token) {
  const user = auth_(token);
  return {data:getPublicData(),role:user.role,username:user.username,ruleDrafts:readRows_(SHEETS.RULE_DRAFTS),ruleHistory:readRows_(SHEETS.RULE_HISTORY).reverse()};
}

function adminSubmitRuleDraft(token, rule) {
  const user = auth_(token);
  if (!['COUNCIL','STAFF','ADMIN','SUPERADMIN'].includes(user.role)) throw new Error('ไม่มีสิทธิ์เสนอแก้ไขกฎ');
  if (!rule || !String(rule.id||'').trim() || !String(rule.title||'').trim() || !String(rule.body||'').trim()) throw new Error('กรุณากรอกรหัส ชื่อ และรายละเอียดกฎให้ครบ');
  const sh = sheet_(SHEETS.RULE_DRAFTS, ['draftId','ruleId','title','category','body','changeNote','submittedBy','submittedAt','status']);
  const draftId = Utilities.getUuid();
  sh.appendRow([draftId,String(rule.id).trim(),String(rule.title).trim(),String(rule.category||''),String(rule.body),String(rule.changeNote||''),user.username,new Date(),'PENDING']);
  log_(user.username, 'ส่งร่างกฎเพื่อรออนุมัติ: '+rule.id);
  return {ok:true,ruleDrafts:readRows_(SHEETS.RULE_DRAFTS)};
}

function adminApproveRuleDraft(token, draftId, decision) {
  const user = auth_(token);
  if (!['COUNCIL','ADMIN','SUPERADMIN'].includes(user.role)) throw new Error('เฉพาะผู้ดูแลประเทศที่ได้รับอนุญาตเท่านั้นที่อนุมัติร่างกฎได้');
  const drafts = readRows_(SHEETS.RULE_DRAFTS);
  const idx = drafts.findIndex(d=>String(d.draftId)===String(draftId));
  if (idx<0) throw new Error('ไม่พบร่างกฎ');
  const draft=drafts[idx];
  if (draft.status!=='PENDING') throw new Error('ร่างกฎนี้ได้รับการพิจารณาแล้ว');
  const sh=db_().getSheetByName(SHEETS.RULE_DRAFTS);
  const row=idx+2;
  if (decision!=='APPROVE') { sh.getRange(row,9).setValue('REJECTED'); log_(user.username,'ไม่อนุมัติร่างกฎ '+draft.ruleId); return {ok:true}; }
  const rules=readRows_(SHEETS.RULES);
  const old=rules.find(r=>String(r.id)===String(draft.ruleId));
  const now=new Date();
  const published={id:draft.ruleId,title:draft.title,category:draft.category,body:draft.body,updatedAt:now,changeNote:draft.changeNote||'มีการเพิ่มหรือแก้ไขกฎ'};
  const next=rules.filter(r=>String(r.id)!==String(draft.ruleId)); next.push(published);
  writeRows_(SHEETS.RULES,['id','title','category','body','updatedAt','changeNote'],next);
  sheet_(SHEETS.RULE_HISTORY,['at','by','ruleId','ruleTitle','action','beforeTitle','beforeCategory','beforeBody','afterTitle','afterCategory','afterBody','changeNote']).appendRow([now,user.username,draft.ruleId,draft.title,old?'แก้ไขและเผยแพร่':'สร้างและเผยแพร่',old?old.title:'',old?old.category:'',old?old.body:'',draft.title,draft.category,draft.body,draft.changeNote||'']);
  sh.getRange(row,9).setValue('APPROVED');
  log_(user.username,'อนุมัติและเผยแพร่กฎ '+draft.ruleId+' (เสนอโดย '+draft.submittedBy+')');
  return {ok:true,data:getPublicData(),ruleDrafts:readRows_(SHEETS.RULE_DRAFTS),ruleHistory:readRows_(SHEETS.RULE_HISTORY).reverse()};
}


// บันทึกร่างกฎอัตโนมัติระหว่างเขียน โดยไม่เผยแพร่จนกว่าสภาจะกดปุ่มเผยแพร่
function adminAutoSaveRule(token, rule) {
  const user = auth_(token);
  if (!['COUNCIL','STAFF','ADMIN','SUPERADMIN'].includes(user.role)) throw new Error('ไม่มีสิทธิ์บันทึกร่างกฎ');
  if (!rule || !String(rule.id || '').trim() || !String(rule.title || '').trim() || !String(rule.body || '').trim()) {
    throw new Error('กรุณากรอกรหัส ชื่อ และรายละเอียดกฎก่อนบันทึกร่าง');
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = sheet_(SHEETS.RULE_DRAFTS, ['draftId','ruleId','title','category','body','changeNote','submittedBy','submittedAt','status']);
    const last = sh.getLastRow();
    const rows = last > 1 ? sh.getRange(2,1,last-1,9).getValues() : [];
    const id = String(rule.id).trim();
    let target = -1;
    for (let i=0;i<rows.length;i++) {
      if (String(rows[i][1]) === id && String(rows[i][8]) === 'AUTOSAVED') target = i + 2;
    }
    const draftId = target > 0 ? String(sh.getRange(target,1).getValue()) : Utilities.getUuid();
    const values = [[draftId,id,String(rule.title).trim(),String(rule.category||''),String(rule.body),String(rule.changeNote||''),user.username,new Date(),'AUTOSAVED']];
    if (target > 0) sh.getRange(target,1,1,9).setValues(values);
    else sh.appendRow(values[0]);
    SpreadsheetApp.flush();
    return {ok:true,draftId:draftId,savedAt:new Date().toISOString()};
  } finally {
    lock.releaseLock();
  }
}

// เผยแพร่กฎทันที: อัปเดตเฉพาะแถวที่เกี่ยวข้อง สำรองฉบับเดิมก่อนเขียน และตรวจสอบข้อมูลหลังบันทึก
function adminPublishRule(token, rule) {
  const user = auth_(token);
  if (!['COUNCIL','STAFF','ADMIN','SUPERADMIN'].includes(user.role)) throw new Error('ไม่มีสิทธิ์เผยแพร่กฎ');
  if (!rule || !String(rule.id || '').trim() || !String(rule.title || '').trim() || !String(rule.body || '').trim()) {
    throw new Error('กรุณากรอกรหัส ชื่อ และรายละเอียดกฎให้ครบ');
  }
  const id = String(rule.id).trim();
  const title = String(rule.title).trim();
  const category = String(rule.category || '').trim();
  const body = String(rule.body);
  const changeNote = String(rule.changeNote || '').trim();
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = sheet_(SHEETS.RULES, ['id','title','category','body','updatedAt','changeNote']);
    const last = sh.getLastRow();
    const rows = last > 1 ? sh.getRange(2,1,last-1,6).getValues() : [];
    let targetRow = -1;
    let old = null;
    for (let i=0;i<rows.length;i++) {
      if (String(rows[i][0]) === id) {
        targetRow = i + 2;
        old = {id:rows[i][0],title:rows[i][1],category:rows[i][2],body:rows[i][3],updatedAt:rows[i][4],changeNote:rows[i][5]};
        break;
      }
    }
    const now = new Date();
    // สำรองข้อมูลเดิมก่อนแก้ไข โดยไม่แตะต้องแถวต้นฉบับ
    if (old) {
      const backup = sheet_('RULES_BACKUP',['backupAt','backupBy','ruleId','title','category','body','updatedAt','changeNote']);
      backup.appendRow([now,user.username,old.id,old.title,old.category,old.body,old.updatedAt,old.changeNote]);
    }
    const values = [[id,title,category,body,now,changeNote || (old ? 'แก้ไขกฎ' : 'สร้างกฎใหม่')]];
    if (targetRow > 0) sh.getRange(targetRow,1,1,6).setValues(values);
    else {
      targetRow = Math.max(2, sh.getLastRow()+1);
      sh.getRange(targetRow,1,1,6).setValues(values);
    }
    SpreadsheetApp.flush();
    const verify = sh.getRange(targetRow,1,1,6).getValues()[0];
    if (String(verify[0]) !== id || String(verify[1]) !== title || String(verify[2]) !== category || String(verify[3]) !== body) {
      throw new Error('ระบบตรวจสอบข้อมูลหลังบันทึกไม่ผ่าน ข้อมูลเดิมถูกเก็บไว้ในระบบสำรอง กรุณาลองอีกครั้ง');
    }
    // บันทึกประวัติหลังยืนยันว่าข้อมูลหลักถูกเขียนสำเร็จแล้ว
    try {
      sheet_(SHEETS.RULE_HISTORY,['at','by','ruleId','ruleTitle','action','beforeTitle','beforeCategory','beforeBody','afterTitle','afterCategory','afterBody','changeNote'])
        .appendRow([now,user.username,id,title,old?'แก้ไขและเผยแพร่ทันที':'สร้างและเผยแพร่ทันที',old?old.title:'',old?old.category:'',old?old.body:'',title,category,body,changeNote]);
    } catch (historyError) {
      // การบันทึกประวัติล้มเหลวไม่ย้อนหรือลบกฎที่เผยแพร่สำเร็จแล้ว
      console.error('RULE_HISTORY write failed: ' + historyError);
    }
    // ทำเครื่องหมายร่างอัตโนมัติที่ตรงกับรหัสนี้ว่าเผยแพร่แล้ว เก็บแถวไว้เป็นหลักฐาน
    try {
      const drafts = db_().getSheetByName(SHEETS.RULE_DRAFTS);
      if (drafts && drafts.getLastRow() > 1) {
        const draftRows = drafts.getRange(2,1,drafts.getLastRow()-1,9).getValues();
        draftRows.forEach((r,i)=>{
          if (String(r[1])===id && String(r[8])==='AUTOSAVED') drafts.getRange(i+2,9).setValue('PUBLISHED');
        });
      }
    } catch (draftError) { console.error('Draft status update failed: ' + draftError); }
    log_(user.username,'เผยแพร่กฎทันที: '+id+' — '+title);
    return {ok:true,data:getPublicData(),ruleDrafts:readRows_(SHEETS.RULE_DRAFTS),ruleHistory:readRows_(SHEETS.RULE_HISTORY).reverse()};
  } finally {
    lock.releaseLock();
  }
}

function adminGetRuleHistory(token) {
  auth_(token);
  return readRows_(SHEETS.RULE_HISTORY).reverse();
}

function adminSave(token, key, value) {
  const user = auth_(token);
  if (value === null || value === undefined) throw new Error('ไม่พบข้อมูลที่ต้องการบันทึก');
  // สมาชิกสภาที่ผ่านการตรวจสอบยศ Council แก้ไขข้อมูลเว็บไซต์ได้ตามสิทธิ์ โดยไม่สามารถจัดการบัญชี/สิทธิ์ได้
  const councilEditable = ['site','categories','rules','news','members'];
  const allowed = user.role === 'SUPERADMIN' || user.role === 'ADMIN' ||
    (user.role === 'STAFF' && ['rules','news'].indexOf(key) >= 0) ||
    (user.role === 'COUNCIL' && councilEditable.indexOf(key) >= 0);
  if (!allowed) throw new Error('บัญชีนี้ไม่มีสิทธิ์แก้ไขข้อมูลส่วนนี้');
  if (key === 'site') {
    const rows = Object.keys(value).map(k => ({key:k,value:value[k]}));
    writeRows_(SHEETS.SETTINGS, ['key','value'], rows);
  } else if (key === 'categories') {
    writeRows_(SHEETS.CATEGORIES, ['id','icon','name','desc'], value);
  } else if (key === 'rules') {
    throw new Error('ไม่อนุญาตให้เผยแพร่กฎโดยตรง กรุณาส่งร่างกฎและรอการอนุมัติจากผู้ดูแลประเทศก่อน');
    if (!Array.isArray(value)) throw new Error('รูปแบบข้อมูลกฎไม่ถูกต้อง');
     const oldRules = readRows_(SHEETS.RULES);
     const oldById = new Map(oldRules.map(r => [String(r.id), r]));
     const now = new Date();
     const rulesWithHistory = value.map(r => {
       const old = oldById.get(String(r.id));
       const changed = !old || String(old.title || '') !== String(r.title || '') ||
         String(old.category || '') !== String(r.category || '') || String(old.body || '') !== String(r.body || '');
       return {id:String(r.id||''),title:String(r.title||''),category:String(r.category||''),body:String(r.body||''),
         updatedAt:changed?now:(r.updatedAt||old.updatedAt||''),
         changeNote:changed?String(r.changeNote||'มีการเพิ่มหรือแก้ไขรายละเอียดกฎ'):String(r.changeNote||old.changeNote||'')};
     });
     writeRows_(SHEETS.RULES, ['id','title','category','body','updatedAt','changeNote'], rulesWithHistory);
  } else if (key === 'news') {
    if (!Array.isArray(value)) throw new Error('รูปแบบข้อมูลประกาศไม่ถูกต้อง');
    const cleanNews = value.map(n => ({
      id: String(n.id || ''),
      title: String(n.title || '').trim(),
      date: String(n.date || '').trim(),
      body: String(n.body || '').trim()
    }));
    if (cleanNews.some(n => !n.id || !n.title || !n.body)) throw new Error('ข้อมูลประกาศไม่ครบ กรุณาตรวจสอบหัวข้อและรายละเอียด');
    writeRows_(SHEETS.NEWS, ['id','title','date','body'], cleanNews);
  } else if (key === 'members') {
    writeRows_(SHEETS.MEMBERS, ['id','name','role','desc'], value);
  } else {
    throw new Error('ประเภทข้อมูลไม่ถูกต้อง');
  }
  log_(user.username, 'แก้ไขข้อมูล: ' + key);
  return {data:getPublicData()};
}

function adminAddAccount(token, username, password, role) {
  const user = auth_(token);
  if (user.role !== 'SUPERADMIN' && user.role !== 'ADMIN') throw new Error('เฉพาะ ADMIN เท่านั้นที่เพิ่มบัญชีได้');
  username = String(username || '').trim();
  password = String(password || '');
  if (!/^[a-zA-Z0-9_.-]{3,30}$/.test(username)) throw new Error('ชื่อผู้ใช้ต้องยาว 3–30 ตัว และใช้ a-z, 0-9, จุด หรือขีด');
  if (password.length < 8) throw new Error('รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร');
  if (['ADMIN','STAFF'].indexOf(role) < 0) throw new Error('สิทธิ์ไม่ถูกต้อง');
  const sh = db_().getSheetByName(SHEETS.USERS);
  const users = readRows_(SHEETS.USERS);
  if (users.some(x => String(x.username).toLowerCase() === username.toLowerCase())) throw new Error('มีชื่อผู้ใช้นี้แล้ว');
  const salt = Utilities.getUuid();
  sh.appendRow([username,salt,hash_(password,salt),role,true]);
  log_(user.username, 'เพิ่มบัญชี ' + username + ' (' + role + ')');
  return true;
}

function adminChangePassword(token, newPassword) {
  const user = auth_(token);
  newPassword = String(newPassword || '');
  if (newPassword.length < 8) throw new Error('รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร');
  const sh = db_().getSheetByName(SHEETS.USERS);
  const users = readRows_(SHEETS.USERS);
  const idx = users.findIndex(x => String(x.username) === String(user.username));
  if (idx < 0) throw new Error('ไม่พบบัญชีผู้ใช้');
  const salt = Utilities.getUuid();
  const row = idx + 2;
  sh.getRange(row,2,1,2).setValues([[salt,hash_(newPassword,salt)]]);
  log_(user.username, 'เปลี่ยนรหัสผ่าน');
  return true;
}

function adminGetLogs(token) {
  auth_(token);
  const rows = readRows_(SHEETS.LOGS);
  return Array.isArray(rows) ? rows.reverse() : [];
}

function auth_(token) {
  if (!token) throw new Error('กรุณาเข้าสู่ระบบใหม่');
  const raw = CacheService.getScriptCache().get('PTC_ADMIN_TOKEN_' + token);
  if (!raw) throw new Error('หมดเวลาเข้าสู่ระบบ กรุณาเข้าสู่ระบบใหม่');
  return JSON.parse(raw);
}

function hash_(password, salt) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + '|' + password, Utilities.Charset.UTF_8);
  return bytes.map(b => ('0' + ((b + 256) % 256).toString(16)).slice(-2)).join('');
}

function log_(by, action) {
  const sh = sheet_(SHEETS.LOGS, ['at','by','action']);
  sh.appendRow([new Date(), by, action]);
  const last = sh.getLastRow();
  if (last > 501) sh.deleteRows(2, last - 501);
}


function authorizeExternalRequest() {
  UrlFetchApp.fetch('https://discord.com');
}

