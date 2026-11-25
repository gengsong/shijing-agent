/**
 * Safety policy. The agent explores pages it does not own, so by default it
 * never presses controls that look like they spend money, delete data, sign
 * in/out, or publish something. Tasks that need those flows are out of scope
 * for v0.1.
 */
const RISKY = /\b(buy|purchase|pay|payment|checkout|order now|place order|book now|add to (cart|bag)|delete|remove account|unsubscribe|sign ?(in|up|out)|log ?(in|out)|register|upload|publish|send|install)\b|购买|支付|删除|注销|上传|发布|发送|下单|预订|注册|登录/i;

export function isAllowed(item) {
  return !RISKY.test(`${item.label} ${item.href || ''}`);
}

export function allowedItems(items) {
  return items.filter(isAllowed);
}
