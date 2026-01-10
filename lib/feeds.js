const FeedParser = require('feedparser');
const axios = require('axios');
const moment = require('moment');
const { convert } = require('html-to-text');
const cheerio = require('cheerio');
const _ = require('lodash');
const jsonfile = require('jsonfile');
const sentiment = require("sentiment-multilang");
const stopwords = require('./stopwords.json');

// Global cache reference (will be set in init)
let cache;
let sources;

const loadSource = async (source) => {
    return new Promise(async (resolve) => {
        try {
            const response = await axios({
                method: 'get',
                url: source.url,
                responseType: 'stream',
                headers: { 'User-Agent': 'Mozilla/5.0' }
            });

            const feedparser = new FeedParser({ normalize: true });
            const articles = [];
            let position = 0;

            if (response.status !== 200) {
                console.error(`Bad status code ${response.status} for ${source.url}`);
                return resolve({ ...source, articles: [] });
            }

            response.data.pipe(feedparser);

            feedparser.on('error', (err) => {
                console.error(`Error parsing feed ${source.name}:`, err.message);
                resolve({ ...source, articles: [] });
            });

            feedparser.on('readable', function () {
                const stream = this;
                let item;

                while ((item = stream.read())) {
                    const images = [];

                    if (item.description) {
                        const $ = cheerio.load(item.description);
                        $('img').each(function () {
                            const src = $(this).attr('src');
                            if (src) images.push(src);
                        });
                    }
                    if (item["rss:photo"] && item["rss:photo"]["#"]) {
                        images.push(item["rss:photo"]["#"]);
                    }

                    const myDesc = item.description ?
                        convert(item.description, {
                            wordwrap: false,
                            selectors: [
                                { selector: 'img', format: 'skip' },
                                { selector: 'a', options: { hideLinkHref: true } }
                            ]
                        }) : item.summary;

                    moment.locale("it");
                    let pubDate;
                    if (item.pubDate == "Invalid Date" && item["rss:pubdate"] && item["rss:pubdate"]["#"]) {
                        pubDate = moment(item["rss:pubdate"]["#"].toLowerCase(), "ddd, ll HH:mm:ss Z");
                    } else {
                        pubDate = moment(item.pubDate);
                    }
                    
                    const published = pubDate.isValid() ? pubDate.format("[h]HH:mm DD/MM/YYYY") : "";

                    articles.push({
                        position: ++position,
                        source: source.name,
                        label: source.label,
                        title: item.title,
                        pubDate: pubDate, // keeping as moment object for internally calculations if needed
                        published: published,
                        url: item.link,
                        images: images,
                        description: myDesc
                    });
                }
            });

            feedparser.on('end', () => {
                articles.forEach(article => {
                    article.weight = Math.max(100 - ((article.position - 1) * 10), 0);
                });
                resolve({ ...source, articles: articles.slice(0, 15) });
            });

        } catch (error) {
            console.error(`Error fetching ${source.url}:`, error.message);
            resolve({ ...source, articles: [] });
        }
    });
};

const lean = (str, stopwordsList) => {
    if (!str) return null;
    
    // Simple cleaning regexes
    const cleanStr = str.toLowerCase()
        .replace(/&nbsp;/g, ' ')
        .replace(/["«».,\-“”:'?!|’;()]/g, ' ') // Combined regex for cleanup
        .replace(/\s+/g, ' ')
        .trim();

    const tokens = cleanStr.split(" ");
    return tokens.filter(token => {
        return token.length > 3 && !stopwordsList.includes(token);
    });
};

const computeSimilarity = (articles) => {
    console.log("processing text...");
    
    // Sort logic from original code.
    // Note: This O(N^2) loop is heavy.
    const sortedArticles = _.sortBy(articles, "position");

    articles.forEach(a => {
        // Initialize structures to avoid undefined checks later
        if (!a.links) a.links = {};
        if (!a.relations) a.relations = {};
        if (!a.confidence) a.confidence = {};

        // Original logic checked against all articles
        // Optimization: checking only against other articles would be enough, but original logic had specific checks
        articles.forEach(b => {
            if (a === b) return;
            if (a.links[b.url] || b.links && b.links[a.url]) return; // Already computed

            const leanA = lean(a.title + " " + a.description, stopwords);
            const leanB = lean(b.title + " " + b.description, stopwords);

            const lenA = leanA ? leanA.length : 0;
            const lenB = leanB ? leanB.length : 0;
            
            if (lenA === 0 || lenB === 0) return;

            const totT = lenA + lenB;
            const minT = (lenA + lenB) / 2; // This matches original logic: (lenA + lenB) / 2
            
            const iTarray = _.intersection(leanA, leanB);
            const iT = iTarray.length;
            
            // Original logic: similarity1 = minT > 0 ? iT / minT : 0; THEN similarity1 = iT; 
            // The assignment `similarity1 = iT` overwrites the previous calculation! 
            // I will preserve the *apparent* intent of the final Code, which used `iT` as the similarity1 value.
            const similarity1 = iT; 

            const similarity = totT > 0 ? similarity1 / totT : 0;
            
            a.links[b.url] = similarity;
            // Since we iterate all pairs (nested loop), we can set b's link now or let the loop reach it. 
            // Original code set both. I'll stick to setting both to avoid re-computation.
            if (!b.links) b.links = {};
            b.links[a.url] = similarity;

            if (!b.relations) b.relations = {};
            
            a.relations[b.url] = iTarray;
            b.relations[a.url] = iTarray;
            
            // Original had a.confidence[b.url] = similarity1; which is just iT (intersection count)
            a.confidence[b.url] = similarity1;
            if (!b.confidence) b.confidence = {};
            b.confidence[a.url] = similarity1;
        });
    });

    // Populate 'related' array
    articles.forEach(article => {
        const tmp = [];
        _.forOwn(article.links, (value, key) => {
            tmp.push({ url: key, similarity: value });
        });
        article.related = _.sortBy(tmp, "similarity").reverse().slice(0, 5);
        // Original code deleted article.links here. I'll keep it consistent.
        delete article.links; 
    });

    console.log("processed", articles.length, "articles");
    return articles;
};

const loadSources = async (sourcesList) => {
    let allArticles = [];
    let loadedCount = 0;

    console.log(`Starting load of ${sourcesList.length} sources...`);
    
    // Using Promise.all to load in parallel
    const results = await Promise.all(sourcesList.map(s => loadSource(s)));
    
    results.forEach(res => {
        console.log(`${res.name} count:`, res.articles.length);
        res.articles.forEach(item => {
             // Initialize properties
            item.links = {};
            item.confidence = {};
            if (item.description) item.description = item.description.replace(/[\r\n]/g, ' ');
            allArticles.push(item);
        });
        loadedCount++;
    });
    
    console.log(`Loaded ${loadedCount} feeds out of ${sourcesList.length}`);
    return { articles: allArticles, corpus: _.keyBy(allArticles, 'url') };
};

const computeTotalWeight = (articles, corpus, minSim, minConf) => {
    articles.forEach(article => {
        article.totalWeight = article.weight;
        if (article.related) {
            article.related.forEach(related => {
                // Check if related exists in corpus (it should)
                const relatedArticle = corpus[related.url];
                if (relatedArticle) {
                    const confidence = article.confidence[related.url];
                    // Logic from original code
                    if ((confidence >= minConf && related.similarity >= minSim) || 
                        confidence >= (minConf * 2) || 
                        related.similarity >= (minSim * 2)) {
                        article.totalWeight += relatedArticle.weight;
                    } else {
                        article.confidence[related.url] = -1;
                    }
                }
            });
        }
    });
    return _.sortBy(articles, "totalWeight").reverse();
};

const markDuplicates = (articles) => {
    const alreadyShown = {};
    articles.forEach(article => {
        if (!alreadyShown[article.url]) {
            alreadyShown[article.url] = true;
            if (article.related) {
                article.related.forEach(related => {
                    if (article.confidence[related.url] >= 0) {
                        alreadyShown[related.url] = true;
                    }
                });
            }
        } else {
            article.alreadyShown = true;
        }
    });
};

const refineText = (articles) => {
    articles.forEach(a => {
        if (a.title) {
            a.title = a.title.replace(/l\?/g, "'").replace(/&#39;/g, "'");
        }
        if (a.description) {
            let desc = a.description.replace(/--/g, "").replace(/l\?/g, "l'").replace(/&#39;/g, "'");
            if (desc.length > 300) desc = desc.substring(0, 300) + "..";
            a.description = desc;
        }
    });
};

const addOverallNumbering = (articles) => {
    let n = 0;
    articles.forEach(a => {
        if (!a.alreadyShown) {
            if (n < 1) a.overallPosition = "top";
            else if (n < 3) a.overallPosition = "highlight";
            else if (n < 14) a.overallPosition = "body";
            else a.overallPosition = "other";
            n++;
        }
    });
};

const addSentiment = (articles) => {
    const evaluate = (phrase) => {
        const res = sentiment(phrase, 'it');
        return { score: res.score, vote: res.vote, comparative: res.comparative.toFixed(2) };
    };

    articles.forEach(a => {
        a.sentiment = evaluate(a.title + " " + a.description);
    });
};

module.exports = {
    init: (_cache) => {
        try {
            sources = jsonfile.readFileSync("sources.json");
            cache = _cache;
        } catch(e) {
            console.error("Error initializing feeds:", e);
        }
    },
    refresh: async (cb) => {
        console.log("Collecting and computing data...");
        try {
            const result = await loadSources(sources);
            let articles = result.articles;
            let corpus = result.corpus;

            // Pipeline
            refineText(articles);
            articles = computeSimilarity(articles); // This function now returns articles
            articles = computeTotalWeight(articles, corpus, 0.05, 2);
            markDuplicates(articles);
            addOverallNumbering(articles);
            addSentiment(articles);

            // Save
            await jsonfile.writeFile("data/articles.json", articles);
            await jsonfile.writeFile("data/corpus.json", corpus);
            
            const status = { lastUpdate: new Date(), count: articles.length };
            await jsonfile.writeFile("data/status.json", status);

            if (cache) {
                cache.put("data", {
                    articles,
                    corpus,
                    sources,
                    status
                }, 60 * 1000, (key, value) => {
                    console.log(new Date(), key, "expired");
                });
            }

            if (cb) cb(articles, corpus, sources, status);

        } catch (err) {
            console.error("Error in refresh:", err);
            if (cb) cb([], {}, sources, { error: err });
        }
    },
    loadFromDisk: () => {
        console.log("loading from disk");
        try {
            const data = {
                articles: jsonfile.readFileSync("data/articles.json"),
                corpus: jsonfile.readFileSync("data/corpus.json"),
                sources: sources,
                status: jsonfile.readFileSync("data/status.json")
            };
            if (cache) {
                cache.put("data", data, 60 * 1000, (key, value) => {
                    console.log(new Date(), key, "expired");
                });
            }
            return data;
        } catch (e) {
            console.error("Error loading from disk:", e);
            return { articles: [], corpus: {}, sources: sources, status: {} };
        }
    },
    load: () => {
        if (cache) {
            return cache.get("data") || module.exports.loadFromDisk();
        }
        return module.exports.loadFromDisk();
    }
};
