import { chromium } from "playwright-core";
import mongoose from "mongoose";
import Price from "./models/price.js"; // 확장자 포함 권장 (ESM 기준)
import EventValueChart from "./models/eventValueChart.js";
import PlayerReports from "./models/playerReports.js";
// import data from "./data.json" assert { type: "json" };
import dbConnect from "./dbConnect.js";
import HanTools from "hangul-tools";
import axios from "axios";
import playerRestrictions from "./seed/playerRestrictions.json" assert { type: "json" };

let browser;

async function initBrowser() {
  if (browser) {
    try {
      await browser.close();
      console.log("🔄 Previous browser closed");
    } catch (error) {
      console.error("⚠ Error closing previous browser:", error.message);
    }
  }

  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.NODE_ENV === "production"
        ? process.env.CHROME_EXECUTABLE_PATH || "/usr/bin/google-chrome-stable"
        : undefined,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-extensions",
      "--disable-gpu",
      "--no-zygote",
    ],
    ignoreHTTPSErrors: true,
  });

  console.log("✅ Playwright browser initialized");
}

// async function dbConnect() {
//   if (mongoose.connection.readyState !== 1) {
//     await mongoose.connect(process.env.MONGO_URI, {
//       useNewUrlParser: true,
//       useUnifiedTopology: true,
//     });
//     console.log("✅ MongoDB connected");
//   }
// }

async function blockUnwantedResources(page) {
  await page.route("**/*", (route) => {
    const blockedTypes = new Set(["image", "stylesheet", "font", "media"]);
    const blockedDomains = ["google-analytics.com", "doubleclick.net"];
    const url = route.request().url();

    if (
      blockedTypes.has(route.request().resourceType()) ||
      blockedDomains.some((domain) => url.includes(domain))
    ) {
      route.abort();
    } else {
      route.continue();
    }
  });
}

async function playerPriceValue(data, Grade) {
  let context;
  let grades;

  if (Array.isArray(Grade)) {
    grades = [...Grade];
  } else {
    grades = [Grade];
  }

  try {
    await initBrowser();
    context = await browser.newContext();
    const results = [];

    for (const player of data) {
      if (playerRestrictions.includes(Number(player.id))) {
        continue;
      } else {
        for (let grade of grades) {
          const { id } = player;
          const url = `https://fconline.nexon.com/DataCenter/PlayerInfo?spid=${id}&n1Strong=${grade}`;
          const page = await context.newPage();
          await blockUnwantedResources(page);

          try {
            console.log(`🌍 Navigating to ${url}`);
            await page.goto(url, { waitUntil: "domcontentloaded" });

            await page.waitForFunction(
              () => {
                const element = document.querySelector(".txt strong");
                return (
                  element &&
                  element.getAttribute("title") &&
                  element.getAttribute("title").trim() !== ""
                );
              },
              { timeout: 80000 }
            );

            let datacenterTitle = await page.evaluate(() => {
              const element = document.querySelector(".txt strong").textContent;
              return element;
            });

            results.push({
              id: id,
              prices: { grade, price: datacenterTitle },
            });

            console.log(`✔ ID ${id} / Grade ${grade} → ${datacenterTitle}`);
          } catch (err) {
            console.error(
              `❌ Error for ID ${id}, Grade ${grade}:`,
              err.message
            );
            results.push({
              id: id,
              prices: { grade, price: "Error" },
            });
          } finally {
            await page.close();
          }
        }
      }
    }

    return results;
  } finally {
    await context?.close();
    await browser?.close();
  }
}

async function saveToDB(results) {
  const bulkOps = results.map(({ id, prices }) => ({
    updateOne: {
      filter: { id: String(id), "prices.grade": prices.grade },
      update: {
        $set: { "prices.$[elem].price": prices.price },
      },
      arrayFilters: [{ "elem.grade": prices.grade }],
      upsert: true,
    },
  }));

  if (bulkOps.length > 0) {
    try {
      await Price.bulkWrite(bulkOps);
      console.log("📦 MongoDB updated");
    } catch (error) {
      console.error("❌ MongoDB bulkWrite failed:", error.message);
    }
  } else {
    console.log("⚠ No data to save");
  }
}

function SortAndSlice(result, slice) {
  let data = [...result];

  data.sort((a, b) => {
    const positionsA = Number(
      HanTools.parseNumber(a.prices.price.replace(",", ""))
    );
    const positionsB = Number(
      HanTools.parseNumber(b.prices.price.replace(",", ""))
    );

    return positionsB - positionsA;
  });

  if (slice !== undefined && slice !== null) {
    data = data.slice(0, slice);
  }

  return data;
}

const playerSearch = async (selectedSeason = "", minOvr = 0) => {
  let selectedSeasons;
  if (Array.isArray(selectedSeason)) {
    selectedSeasons = [...selectedSeason];
  } else {
    selectedSeasons = [selectedSeason];
  }
  const seasonNumbers = [];
  const inputplayer = "";

  // 이미 배열 형태로 전달된 selectedSeasons과 selectedPositions 사용

  for (let season of selectedSeasons) {
    seasonNumbers.push(Number(String(season).slice(-3)));
  }

  let playerReports = [];

  const queryCondition = [{ name: new RegExp(inputplayer) }];

  if (minOvr && minOvr > 10) {
    queryCondition.push({
      "능력치.포지션능력치.최고능력치": {
        $gte: Number(minOvr),
      },
    });
  }

  if (seasonNumbers && seasonNumbers.length > 0) {
    for (let seasonNumber of seasonNumbers) {
      seasonNumber *= 1000000;

      const seasonCondition = {
        id: {
          $gte: seasonNumber,
          $lte: seasonNumber + 999999,
        },
      };

      queryCondition.push(seasonCondition);

      let playerReport = await PlayerReports.find({
        $and: queryCondition,
      })
        .populate({
          path: "선수정보",
          populate: {
            path: "prices", // 중첩된 필드를 처리
            model: "Price",
          },
        })
        .populate({
          path: "선수정보.시즌이미지",
          populate: {
            path: "시즌이미지",
            model: "SeasonId",
          },
        })
        .sort({ "능력치.포지션능력치.포지션최고능력치": -1 })
        .limit(10000);
      queryCondition.pop();
      playerReports = playerReports.concat(playerReport);
    }
  } else {
    let playerReport = await PlayerReports.find({
      $and: queryCondition,
    })
      .populate({
        path: "선수정보",
        populate: {
          path: "prices", // 중첩된 필드를 처리
          model: "Price",
        },
      })
      .populate({
        path: "선수정보.시즌이미지",
        populate: {
          path: "시즌이미지",
          model: "SeasonId",
        },
      })
      .sort({ "능력치.포지션능력치.포지션최고능력치": -1 })
      .limit(10000);

    playerReports = playerReports.concat(playerReport);
  }

  return playerReports;
};

async function main() {
  try {
    const data = {
      id: "new 아이콘 로드 3500",
      updateTime: "",
      seasonPack: [],
    };

    const ICON_TM_TOP_ALL = {
      packName: "ICON TM 클래스 Top Price ALL 동일확률 프리미엄 팩 (5강)",
      playerPrice: [],
    };
    const CU_TOP_150 = {
      packName: "CU 클래스 Top Price 150 스페셜팩 (8강, 110+)",
      playerPrice: [],
    };

    await dbConnect();

    // // -------------------------------------- ICON_TOP_ALL--------------------------------------

    // const ICONTM_LIST = await playerSearch([100], 0); // playerSearch(시즌넘버, 최소오버롤)
    // let ICONTM_RESULTS = await playerPriceValue(ICONTM_LIST, 5); // playerPriceValue(데이터 , 강화등급)
    // await saveToDB(ICONTM_RESULTS);
    // const ICONTM_FINAL = SortAndSlice(ICONTM_RESULTS); // SortAndSlice(데이터 , 자르기숫자)

    // for (let item of ICONTM_FINAL) {
    //   const playerDocs = await Price.find({ id: item.id });
    //   if (playerDocs.length > 0 && playerDocs[0]._id) {
    //     const playerData = {
    //       grade: item.prices.grade,
    //       playerPrice: playerDocs[0]?._id || null,
    //     };
    //     ICON_TM_TOP_ALL.playerPrice.push(playerData);
    //   }
    // }
    // data.seasonPack.push({ ...ICON_TM_TOP_ALL });
    // --------------------------------------   ICONS MATCH, ICON, MDL, UT, 24KB, DC, CC, 23HW, HG _TOP 550--------------------------------------

    const CU_TOP_150_LIST = await playerSearch(
      [111, 101, 821, 814, 830, 802, 289, 291, 283],
      111
    ); // playerSearch(시즌넘버, 최소오버롤)
    let CU_TOP_150_RESULTS = await playerPriceValue(
      CU_TOP_150_LIST,
      [5, 6, 7, 8]
    ); // playerPriceValue(데이터 , 강화등급)
    await saveToDB(CU_TOP_150_RESULTS);
    const CU_TOP_150_FINAL = SortAndSlice(CU_TOP_150_RESULTS, 550); // SortAndSlice(데이터 , 자르기숫자)

    for (let item of CU_TOP_150_FINAL) {
      const playerDocs = await Price.find({ id: item.id });
      if (playerDocs.length > 0 && playerDocs[0]._id) {
        const playerData = {
          grade: item.prices.grade,
          playerPrice: playerDocs[0]?._id || null,
        };
        CU_TOP_150.playerPrice.push(playerData);
      }
    }
    data.seasonPack.push({ ...CU_TOP_150 });

    // -------------------------------------------------------------------------------------------------------------------------------

    const doc = await EventValueChart.findOne({
      id: "new 아이콘 로드 3500",
    }).lean();

    let mergedSeasonPacks = [];
    const now = new Date();
    const koreaTime = new Date(now.getTime() + 9 * 60 * 60 * 1000);

    if (doc) {
      const existingSeasonPacks = doc.seasonPack;

      mergedSeasonPacks = [...existingSeasonPacks];

      for (const incoming of data.seasonPack) {
        const index = mergedSeasonPacks.findIndex(
          (pack) => pack.packName === incoming.packName
        );

        if (index > -1) {
          mergedSeasonPacks[index] = {
            ...mergedSeasonPacks[index],
            ...incoming,
          };
        } else {
          mergedSeasonPacks.push(incoming);
        }
      }
    } else {
      mergedSeasonPacks = data.seasonPack;
    }

    // 🔧 에러 방지를 위한 toObject 처리
    const finalSeasonPack = mergedSeasonPacks.map((pack) =>
      typeof pack.toObject === "function" ? pack.toObject() : pack
    );

    console.log("finalSeasonPack:", finalSeasonPack);

    await EventValueChart.updateOne(
      { id: "new 아이콘 로드 3500" },
      {
        $set: {
          updateTime: koreaTime,
          seasonPack: finalSeasonPack,
        },
      },
      { upsert: true }
    );

    console.log("✅ Crawling process completed.");
    process.exit(0);
  } catch (error) {
    console.error("❌ Error in crawler:", error.message);
    process.exit(1);
  }
}

main();
