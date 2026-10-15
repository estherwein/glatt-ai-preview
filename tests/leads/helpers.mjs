import fs from 'node:fs';
import vm from 'node:vm';
import {createHash, createHmac, randomUUID} from 'node:crypto';

export const ORIGIN = 'https://glatt-review-example.vercel.app';
export const REQUEST_ID = '12345678-1234-4123-8123-123456789abc';
export const SECRET = 'a'.repeat(64); // Public test fixture, never a deployed credential.
export const lead = () => ({name:'ישראל בדיקה', phone:'050-1234567', email:'test@example.com',
  background:'אין רקע', process:'מיון פניות', page:ORIGIN + '/'});
export const input = () => ({requestId:REQUEST_ID, lead:lead(), website:'', elapsedMs:5000});
export const env = () => ({ENVIRONMENT:'preview', ENABLED:'true', ALLOWED_ORIGINS:JSON.stringify([ORIGIN]),
  HMAC_SECRET:SECRET, APPS_SCRIPT_URL:'https://script.google.com/macros/s/test-deployment/exec',
  LEAD_RATE_LIMITER:{limit:async () => ({success:true})}, GLOBAL_RATE_LIMITER:{limit:async () => ({success:true})}});
export function request(body = input(), overrides = {}) {
  return new Request('https://glattai-leads-review.example.workers.dev/leads', {
    method:'POST', headers:{Origin:ORIGIN, 'Content-Type':'application/json', 'CF-Connecting-IP':'192.0.2.1'},
    body:JSON.stringify(body), ...overrides
  });
}

// Local Apps Script service doubles. No Google account, network, email or sheet is touched.
export function gasHarness() {
  const state = {now:Date.now(), rows:[], mails:[], locked:false, quota:100, triggers:[],
    appendCalls:0, failAppend:false, failMail:false, failFinish:false, failAfterAppend:false};
  const props = {ENVIRONMENT:'preview', ENABLED:'true', HMAC_SECRET:SECRET,
    SHEET_ID:'test_spreadsheet_id_123456789', SHEET_NAME:'Leads',
    NOTIFICATION_EMAIL:'owner@example.com', ALLOWED_ORIGINS:JSON.stringify([ORIGIN])};
  const range = (row, column, height = 1, width = 1) => ({
    getValues: () => Array.from({length:height}, (_, r) => Array.from({length:width}, (_, c) => state.rows[row - 1 + r]?.[column - 1 + c] ?? '')),
    setValues(values) {
      if (state.failFinish && column === 12 && values[0][0] === 'sent') throw new Error('private SMTP recipient');
      for (let r = 0; r < height; r++) {
        state.rows[row - 1 + r] ||= [];
        for (let c = 0; c < width; c++) state.rows[row - 1 + r][column - 1 + c] = values[r][c];
      }
      return this;
    },
    setFontWeight() { return this; },
    createTextFinder(value) {
      return {matchEntireCell(){return this;}, useRegularExpression(){return this;}, findNext() {
        for (let i = row - 1; i < row - 1 + height; i++) if (state.rows[i]?.[column - 1] === value) return {getRow:() => i + 1};
        return null;
      }};
    }
  });
  const sheet = {getLastRow:() => state.rows.length, getRange:range, getSheetId:() => 42,
    getParent:() => ({getId:() => props.SHEET_ID}), getName:() => props.SHEET_NAME,
    setFrozenRows(){}, setRightToLeft(){}};
  const book = {getSheetByName:() => sheet, insertSheet:() => sheet, setSpreadsheetTimeZone(){}};
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [state.now])); }
    static now() { return state.now; }
  }
  const signed = bytes => Array.from(bytes, b => b > 127 ? b - 256 : b);
  const context = vm.createContext({
    Date:Clock,
    console:{log(){throw new Error('Application must not log PII');}, error(){throw new Error('Application must not log PII');}},
    PropertiesService:{getScriptProperties:() => ({getProperties:() => ({...props})})},
    Utilities:{
      getUuid:randomUUID, Charset:{UTF_8:'UTF-8'}, DigestAlgorithm:{SHA_256:'SHA-256'},
      newBlob:value => ({getBytes:() => signed(Buffer.from(value, 'utf8'))}),
      computeDigest:(_, value) => signed(createHash('sha256').update(value).digest()),
      computeHmacSha256Signature:(value, key) => signed(createHmac('sha256', key).update(value).digest()),
      formatDate:date => date.toISOString()
    },
    LockService:{getScriptLock:() => ({
      tryLock(){if (state.locked || state.forceLock) return false; state.locked = true; return true;},
      releaseLock(){state.locked = false;}
    })},
    SpreadsheetApp:{openById:() => book, flush(){}},
    Sheets:{Spreadsheets:{Values:{
      get(id, target) {
        const [,startColumn,startRow,endColumn,endRow] = target.match(/!([A-Z])(\d+):([A-Z])(\d*)$/);
        const row=Number(startRow), column=startColumn.charCodeAt(0)-64;
        const height=Number(endRow || state.rows.length)-row+1;
        return {values:height > 0 ? range(row,column,height,endColumn.charCodeAt(0)-startColumn.charCodeAt(0)+1).getValues() : []};
      },
      update(body,id,target,options) {
        if(options.valueInputOption !== 'RAW')throw new Error('Unsafe metadata write');
        const [,row]=target.match(/!L(\d+):R\d+$/);
        range(Number(row),12,1,7).setValues(body.values);
      },
      append(body, id, target, options) {
        if (state.failAppend) throw new Error('Private spreadsheet detail');
        if (options.valueInputOption !== 'RAW') throw new Error('Unsafe cell input mode');
        state.appendCalls++;
        state.onAppend?.();
        state.rows.push(Array.from(body.values[0]));
        if (state.failAfterAppend) throw new Error('Connection lost after durable write');
        return {updates:{updatedRange:'Leads!A' + state.rows.length + ':R' + state.rows.length}};
      }
    }}},
    MailApp:{getRemainingDailyQuota:() => state.quota, sendEmail(message) {
      if (state.rows.length < 2) throw new Error('Email before save');
      state.onMail?.();
      if (state.failMail) throw new Error('Sensitive mail provider exception');
      state.mails.push(message); state.quota--;
    }},
    ScriptApp:{getProjectTriggers:() => state.triggers,
      newTrigger:name => ({timeBased(){return this;}, everyMinutes(){return this;}, create(){state.triggers.push({getHandlerFunction:() => name});}})},
    ContentService:{MimeType:{JSON:'application/json'}, createTextOutput:text => ({setMimeType:() => text})}
  });
  vm.runInContext(fs.readFileSync(new URL('../../assets/leads-core.js', import.meta.url), 'utf8'), context);
  vm.runInContext(fs.readFileSync(new URL('../../google-apps-script/Code.gs', import.meta.url), 'utf8'), context);
  context.setupLeads();
  return {state, props, context, post:envelope => JSON.parse(context.doPost({postData:{type:'application/json', contents:JSON.stringify(envelope)}}))};
}

export function envelope(harness, changes = {}, payloadChanges = {}) {
  const payload = {origin:ORIGIN, lead:lead(), website:'', elapsedMs:5000, ...payloadChanges};
  const result = {version:1, environment:'preview', timestamp:harness.state.now, requestId:REQUEST_ID,
    payload:JSON.stringify(payload), ...changes};
  result.signature = createHmac('sha256', SECRET).update(harness.context.GlattLeads.signingText(result)).digest('hex');
  return result;
}
