/**
 * game_rules.js
 * 服务器侧的「合法性」复核层——与回合归属校验是两件不同的事:
 *   - 是否轮到你、房间是否处于 playing 状态 —— 这些仍由 server.js 的
 *     move 处理逻辑负责,不属于这里
 *   - 这一步棋本身站不站得住脚(五子棋要落在空白且未越界的交叉点、
 *     象棋要符合棋子走法……)—— 这才是这个文件该管的事
 *
 * 当前版本:刻意留空。isLegal() 恒返回合法,不做任何实际判断。
 * 以后接入具体棋类规则时,只需要往 isLegal() 里加判断逻辑,server.js
 * 调用它的地方不需要改——这也是单独拆一个文件出来的意义:棋类规则
 * 变化时改动范围只在这一个文件里。
 */

class GameRules {
  constructor(options = {}) {
    // 预留位:以后可能需要按棋类传入棋盘尺寸、规则变体等配置。
    // 目前没有任何规则用到它,先占个位置。
    this.options = options;
  }

  /**
   * 判断这一步棋本身是否合法(不含"是否轮到你"——那部分 server.js 已经查过)。
   * @param {object} room    落子前的房间状态快照(turn/turnCount/history/state 等)
   * @param {'A'|'B'} seat   落子方
   * @param {*} payload      客户端提交的落子数据,具体格式由游戏类型自行约定
   * @returns {{ legal: boolean, message?: string }}
   *   legal=false 时,message 是给客户端看的人类可读原因(可选)
   */
  isLegal(room, seat, payload) {
    // TODO: 目前没有任何规则——不管传什么 payload 都判定为合法。
    // 以后加具体棋类判断时,例如五子棋可以在这里检查:
    //   - payload.x / payload.y 是否在棋盘范围内
    //   - 该坐标是否已经有子(需要访问 room.history 重建棋盘状态)
    // 不合法时返回 { legal: false, message: '这里写清楚原因' }
    return { legal: true };
  }
}

module.exports = { GameRules };
