// host it on cloudflare workers
addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  const url = new URL(request.url);
  const method = request.method;
  
  const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST",
      "Access-Control-Allow-Headers": "Content-Type"
  };

  try {
      if (method === "OPTIONS") {
          return new Response(null, {
              status: 204,
              headers: corsHeaders
          });
      }

      if (url.pathname === '/' || !url.pathname.startsWith('/search')) {
          return new Response(JSON.stringify({ status: "ok" }), {
              status: 200,
              headers: {
                  ...corsHeaders,
                  "Content-Type": "application/json"
              }
          });
      }

      if (url.pathname === '/search' && method === "POST") {
          const body = await request.json();
          
          if (!body.search_text) {
              return new Response(JSON.stringify({ error: "Missing search_text" }), {
                  status: 400,
                  headers: {
                      ...corsHeaders,
                      "Content-Type": "application/json"
                  }
              });
          }

          const results = await getSearchResults(body.search_text);

          return new Response(JSON.stringify({ results }), {
              status: 200,
              headers: {
                  ...corsHeaders,
                  "Content-Type": "application/json"
              }
          });
      }

      return new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: {
              ...corsHeaders,
              "Content-Type": "application/json"
          }
      });

  } catch (error) {
      return new Response(JSON.stringify({ error: "Internal server error" }), {
          status: 500,
          headers: {
              ...corsHeaders,
              "Content-Type": "application/json"
          }
      });
  }
}

async function extractDate(html) {
  try {
      const tags = ['article:published_time', 'datetime'];
      for (const tag of tags) {
          if (html.includes(`${tag}="`)) {
              const start = html.indexOf(`${tag}="`) + tag.length + 2;
              const end = html.indexOf('"', start);
              const dateStr = html.slice(start, end).replace('Z', '+00:00');
              return new Date(dateStr).toISOString().split('T')[0];
          }
      }
  } catch (error) {
      console.error('Date extraction failed:', error);
  }
  return new Date().toISOString().split('T')[0];
}

async function decodeDuckDuckGoUrl(ddgUrl) {
  if (ddgUrl.includes('uddg=')) {
      try {
          return decodeURIComponent(ddgUrl.split('uddg=')[1].split('&')[0]);
      } catch {
          return ddgUrl;
      }
  }
  return ddgUrl;
}

async function duckduckgoSearch(query) {
  const encodedQuery = encodeURIComponent(query);
  const url = `https://duckduckgo.com/html/?q=${encodedQuery}`;
  
  const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
  };

  try {
      const response = await fetch(url, { headers });
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      
      const text = await response.text();
      if (!text) throw new Error("No text returned from DuckDuckGo");

      const links = [];
      let start = 0;
      const limit = 6;

      while (links.length < limit && text.indexOf('class="result__url"', start) !== -1) {
          start = text.indexOf('class="result__url"', start);
          const hrefStart = text.indexOf('href="', start) + 6;
          const hrefEnd = text.indexOf('"', hrefStart);
          links.push(text.slice(hrefStart, hrefEnd));
          start = hrefEnd;
      }

      const decodedLinks = await Promise.all(links.map(decodeDuckDuckGoUrl));
      return decodedLinks.filter(link => link.startsWith('http')).slice(0, 4);

  } catch (error) {
      console.error('Search failed:', error);
      return [];
  }
}

async function fetchUrl(url) {
  const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  };

  try {
      const response = await fetch(url, { headers });
      const text = await response.text();

      let title = url;
      if (text.includes('<title>')) {
          const start = text.indexOf('<title>') + 7;
          const end = text.indexOf('</title>', start);
          title = text.slice(start, end).trim().substring(0, 150);
      }

      let summary = "No summary available";
      const metaTags = ['name="description"', 'property="og:description"'];
      for (const meta of metaTags) {
          if (text.includes(meta)) {
              const start = text.indexOf('content="', text.indexOf(meta)) + 9;
              const end = text.indexOf('"', start);
              summary = text.slice(start, end).trim().substring(0, 600);
              break;
          }
      }

      if (!summary && text.includes('<p>')) {
          const start = text.indexOf('<p>') + 3;
          const end = text.indexOf('</p>', start);
          summary = text.slice(start, end).trim().substring(0, 600);
      }

      let content = "No content available";
      const contentElements = ['article', 'main', 'div[class*="content"]'];
      for (const element of contentElements) {
          if (text.includes(`<${element}`)) {
              const start = text.indexOf(`<${element}`);
              const end = text.indexOf(`</${element}>`, start);
              if (end !== -1) {
                  content = text.slice(start, end + element.length + 3)
                      .replace(/<[^>]+>/g, '')
                      .replace(/\s+/g, ' ')
                      .trim()
                      .substring(0, 10000);
                  break;
              }
          }
      }

      const date = await extractDate(text);

      return {
          title,
          summary,
          content,
          source_link: url,
          date
      };

  } catch (error) {
      console.error(`Fetch failed for ${url}:`, error);
      return null;
  }
}

async function getSearchResults(searchText) {
  const query = `${searchText}`;
  const searchResults = await duckduckgoSearch(query);

  if (!searchResults.length) return [];

  const fetchTasks = searchResults.map(url => fetchUrl(url));
  const results = await Promise.all(fetchTasks);

  return results
      .filter(result => result !== null)
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, 5);
}