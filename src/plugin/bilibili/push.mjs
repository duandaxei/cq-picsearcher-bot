import _ from 'lodash-es';
import CQ from '../../utils/CQcode.mjs';
import emitter from '../../utils/emitter.mjs';
import logError from '../../utils/logError.mjs';
import { sleep } from '../../utils/sleep.mjs';
import { getUserNewDynamicsInfo } from './dynamic.mjs';
import { getDynamicInfoFromItem } from './dynamicNew.mjs';
import { BiliBiliDynamicFeed } from './feed.mjs';
import { getUsersLiveData } from './live.mjs';
import { getUserSeasonNewVideosInfo } from './season.mjs';
import { purgeLink } from './utils.mjs';

let pushConfig = { dynamic: {}, live: {}, season: {}, series: {} };
const liveStatusMap = new Map();
let enableFeed = false;
let checkPushTask = null;
let checkFeedTask = null;
/** @type {BiliBiliDynamicFeed} */
let dynamicFeed = null;

emitter.onConfigLoad(init);

function init() {
  if (checkPushTask) {
    clearInterval(checkPushTask);
    checkPushTask = null;
  }
  if (checkFeedTask) {
    clearInterval(checkFeedTask);
    checkFeedTask = null;
  }
  pushConfig = getPushConfig();
  for (const uid of liveStatusMap.keys()) {
    if (!(uid in pushConfig.live)) liveStatusMap.delete(uid);
  }
  enableFeed = BiliBiliDynamicFeed.enable;
  if (enableFeed) {
    dynamicFeed = new BiliBiliDynamicFeed();
  }
  const hasDynamicOrLive = _.size(pushConfig.dynamic) || _.size(pushConfig.live);
  if ((!enableFeed && hasDynamicOrLive) || _.size(pushConfig.season)) {
    checkPushTask = setInterval(checkPush, Math.max(global.config.bot.bilibili.pushCheckInterval, 30) * 1000);
    checkPush();
  }
  if (enableFeed && hasDynamicOrLive) {
    checkFeedTask = setInterval(checkFeed, Math.max(global.config.bot.bilibili.feedCheckInterval, 5) * 1000);
    checkFeed();
  }
}

function getPushConfig() {
  const dynamic = {};
  const live = {};
  const season = {};
  const series = {};
  _.each(global.config.bot.bilibili.push, (confs, uid) => {
    if (!Array.isArray(confs)) return;
    dynamic[uid] = [];
    live[uid] = [];
    confs.forEach(conf => {
      if (typeof conf === 'number') {
        dynamic[uid].push({ gid: conf });
        live[uid].push({ gid: conf });
      } else if (typeof conf === 'object' && typeof conf.gid === 'number') {
        if (conf.dynamic === true) dynamic[uid].push({ gid: conf.gid, atAll: conf.dynamicAtAll });
        else if (conf.video === true) dynamic[uid].push({ gid: conf.gid, atAll: conf.dynamicAtAll, onlyVideo: true });
        if (conf.live === true) live[uid].push({ gid: conf.gid, atAll: conf.liveAtAll });
        if (conf.seasons && conf.seasons.length) {
          conf.seasons.forEach(sid => {
            const key = `${uid}:${sid}`;
            if (!season[key]) season[key] = [];
            season[key].push({ gid: conf.gid, atAll: conf.seasonAtAll });
          });
        }
        if (conf.series && conf.series.length) {
          conf.series.forEach(sid => {
            const key = `${uid}:${sid}`;
            if (!series[key]) series[key] = [];
            series[key].push({ gid: conf.gid, atAll: conf.seriesAtAll });
          });
        }
      }
    });
    if (!dynamic[uid].length) delete dynamic[uid];
    if (!live[uid].length) delete live[uid];
  });
  return { dynamic, live, season, series };
}

async function checkPush() {
  const tasks = _.flatten(
    await Promise.all([
      ...(!enableFeed
        ? [
            checkDynamic().catch(e => {
              console.error('[BilibiliPush] check dynamic');
              logError(e);
              return [];
            }),
          ]
        : []),
      checkLive().catch(e => {
        console.error('[BilibiliPush] check live');
        logError(e);
        return [];
      }),
      checkSeason('season').catch(e => {
        console.error('[BilibiliPush] check season');
        logError(e);
        return [];
      }),
      checkSeason('series').catch(e => {
        console.error('[BilibiliPush] check series');
        logError(e);
        return [];
      }),
    ])
  );
  for (const task of tasks) {
    await task();
    await sleep(1000);
  }
}

async function checkDynamic() {
  const dynamicMap = {};
  await Promise.all(
    Object.keys(pushConfig.dynamic).map(async uid => {
      dynamicMap[uid] = await getUserNewDynamicsInfo(uid);
    })
  );
  const tasks = [];
  for (const [uid, confs] of Object.entries(pushConfig.dynamic)) {
    const dynamics = dynamicMap[uid];
    if (!dynamics || !dynamics.length) continue;
    for (const { type, text } of dynamics) {
      for (const { gid, atAll, onlyVideo } of confs) {
        if (onlyVideo && type !== 8) continue;
        tasks.push(() =>
          global.sendGroupMsg(gid, atAll ? `${text}\n\n${CQ.atAll()}` : text).catch(e => {
            console.error(`[BilibiliPush] push dynamic to group ${gid}`);
            logError(e);
          })
        );
      }
    }
  }
  return tasks;
}

async function checkLive() {
  const liveMap = await getUsersLiveData(Object.keys(pushConfig.live));
  const tasks = [];
  for (const [uid, confs] of Object.entries(pushConfig.live)) {
    const liveData = liveMap[uid];
    if (!liveData) continue;
    const { status, name, url, title, cover } = liveData;
    const oldStatus = liveStatusMap.get(uid);
    liveStatusMap.set(uid, status);
    if (status === 1 && status !== oldStatus) {
      for (const { gid, atAll } of confs) {
        tasks.push(() =>
          global
            .sendGroupMsg(
              gid,
              [CQ.img(cover), `【${name}】${title}`, purgeLink(url), ...(atAll ? [CQ.atAll()] : [])].join('\n')
            )
            .catch(e => {
              console.error(`[BilibiliPush] push live to group ${gid}`);
              logError(e);
            })
        );
      }
    }
  }
  return tasks;
}

/**
 * @param {'season' | 'series'} type
 */
async function checkSeason(type) {
  const map = {};
  await Promise.all(
    Object.keys(pushConfig[type]).map(async usid => {
      map[usid] = await getUserSeasonNewVideosInfo(usid, type);
    })
  );
  const tasks = [];
  for (const [usid, confs] of Object.entries(pushConfig[type])) {
    const texts = map[usid];
    if (!texts || !texts.length) continue;
    for (const text of texts) {
      for (const { gid, atAll } of confs) {
        tasks.push(() =>
          global.sendGroupMsg(gid, atAll ? `${text}\n\n${CQ.atAll()}` : text).catch(e => {
            console.error(`[BilibiliPush] push ${type} video to group ${gid}`);
            logError(e);
          })
        );
      }
    }
  }
  return tasks;
}

async function checkFeed() {
  if (!dynamicFeed.isAvailable) {
    clearInterval(checkFeedTask);
    dynamicFeed = null;
    const sendNotice = () =>
      global.sendMsg2Admin(
        '哔哩哔哩cookie已过期，推送暂停，请配置新cookie后重载配置以重新启用推送（该提醒每6小时重复提醒一次）'
      );
    checkFeedTask = setInterval(sendNotice, 6 * 3600 * 1000);
    sendNotice();
    return;
  }

  const newItems = await dynamicFeed.checkAndGetNewDynamic();
  if (!newItems.length) return;

  const tasks = await handleFeedDynamic(newItems);

  for (const task of tasks) {
    await task();
    await sleep(1000);
  }
}

/**
 * @param {any[]} items
 * @param {(item: any) => boolean} filter
 * @returns {Record<string, Promise<{ id: string; type: string; text: string }>[]>}
 */
function getFeedMap(items, filter) {
  return _.transform(
    items.filter(filter),
    (map, item) => {
      const uid = String(item.modules.module_author.mid);
      if (!(uid in map)) map[uid] = [];
      map[uid].push(getDynamicInfoFromItem(item));
    },
    {}
  );
}

async function handleFeedDynamic(items) {
  const dynamicMap = getFeedMap(items, ({ modules }) => String(modules.module_author.mid) in pushConfig.dynamic);
  const tasks = [];
  for (const [uid, confs] of Object.entries(pushConfig.dynamic)) {
    const dynamics = dynamicMap[uid];
    if (!dynamics?.length) continue;
    for await (const { id, type, text } of dynamics) {
      if (text.includes('详情请点击互动抽奖查看')) continue;
      for (const { gid, atAll, onlyVideo } of confs) {
        if (onlyVideo && type !== 'MAJOR_TYPE_ARCHIVE') continue;
        tasks.push(() => {
          if (global.config.bot.debug) console.log(`[BilibiliPush] push dynamic ${id} to group ${gid}`);
          return global.sendGroupMsg(gid, atAll ? `${text}\n\n${CQ.atAll()}` : text).catch(e => {
            console.error(`[BilibiliPush] push dynamic to group ${gid}`);
            logError(e);
          });
        });
      }
    }
  }
  return tasks;
}
