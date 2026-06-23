# ============================================================
# HUGGING FACE SPACE - REDDIT INSPECTOR API
# ============================================================

import os
import re
import json
import time
import asyncio
import random
import uuid
from typing import Optional, List, Dict, Any
from fastapi import FastAPI, Request, BackgroundTasks
from fastapi.responses import JSONResponse, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from curl_cffi import requests as cffi_requests

app = FastAPI(title="Reddit Inspector API")

# CORS for frontend (Render URL and local development)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, restrict to your Render URL or domain
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------- PROXY CONFIG ----------
PROXY_STRING = os.environ.get("PROXY_STRING", "").strip()
PROXIES = []
IS_SINGLE_ROTATING_GATEWAY = False

def load_proxies():
    global PROXIES, IS_SINGLE_ROTATING_GATEWAY
    if PROXY_STRING:
        PROXIES = [PROXY_STRING]
        IS_SINGLE_ROTATING_GATEWAY = True
        print(f"[PROXY] Loaded proxy configuration: {PROXY_STRING[:30]}...")
    else:
        print("[PROXY] No proxy configured! Scraping will run directly (may get blocked/throttled).")

load_proxies()

def get_healthy_proxy() -> Optional[str]:
    return PROXIES[0] if PROXIES else None

# ---------- CACHING ----------
CACHE_TTL = 3600
_cache_store = {}

def cache_get(key: str) -> Optional[Any]:
    if key in _cache_store:
        ts, data = _cache_store[key]
        if time.time() - ts < CACHE_TTL:
            return data
        del _cache_store[key]
    return None

def cache_set(key: str, data: Any):
    _cache_store[key] = (time.time(), data)

# ---------- BULK JOB STORE ----------
_bulk_jobs = {}

# ---------- FETCH FUNCTIONS ----------
IMPERSONATIONS = ["chrome120", "chrome110", "chrome101"]
from urllib.parse import urljoin

async def establish_session(proxy: Optional[str] = None) -> cffi_requests.AsyncSession:
    """Creates and initializes a cffi_requests.AsyncSession by solving the JS challenge.
    Falls back to direct connection if proxy fails.
    """
    configs = []
    if proxy:
        configs.append(({"http": proxy, "https": proxy}, "Proxy"))
    configs.append((None, "Direct"))
    
    headers = {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Connection": "keep-alive",
        "Sec-Ch-Ua": '"Google Chrome";v="120", "Chromium";v="120", "Not_A Brand";v="24"',
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Platform": '"Windows"',
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        "Upgrade-Insecure-Requests": "1",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    }
    
    last_error = None
    for proxies_config, label in configs:
        current_timeout = 8.0 if label == "Proxy" else 15.0
        
        for impersonation in IMPERSONATIONS:
            session = None
            try:
                session = cffi_requests.AsyncSession(
                    impersonate=impersonation,
                    proxies=proxies_config,
                    verify=False,
                    timeout=current_timeout,
                )
                
                # Pre-populate defaults in the session cookie jar
                session.cookies.set("over18", "1")
                session.cookies.set("csv", "2")
                session_cookie = os.environ.get("REDDIT_SESSION_COOKIE") or os.environ.get("REDDIT_SESSION")
                if session_cookie:
                    session.cookies.set("reddit_session", session_cookie)
                
                # Fetch pics subreddit HTML to get JS challenge
                url = "https://www.reddit.com/r/pics/"
                resp = await session.get(url, headers=headers, timeout=current_timeout)
                
                if resp.status_code == 403:
                    last_error = f"[{label}] 403 Forbidden (Blocked by Network Security)"
                    await session.close()
                    continue
                
                html = resp.text
                if "Please wait for verification" in html or "js_challenge" in html:
                    token_match = re.search(r'name="token"\s+value="([^"]+)"', html)
                    action_match = re.search(r'action="([^"]+)"', html)
                    sol_string_match = re.search(r'\("([0-9a-fA-F]+)"\)\);e\.elements', html)
                    
                    if not (token_match and action_match and sol_string_match):
                        last_error = f"[{label}] Failed to parse JS challenge components"
                        await session.close()
                        continue
                        
                    token = token_match.group(1)
                    action = action_match.group(1)
                    sol_base = sol_string_match.group(1)
                    solution = sol_base + sol_base
                    
                    submit_url = urljoin("https://www.reddit.com", action)
                    params = {
                        "solution": solution,
                        "js_challenge": "1",
                        "token": token,
                        "jsc_orig_r": ""
                    }
                    
                    headers_submit = headers.copy()
                    headers_submit["Referer"] = url
                    
                    submit_resp = await session.get(submit_url, params=params, headers=headers_submit, timeout=current_timeout)
                    if submit_resp.status_code == 200:
                        print(f"[SESSION] Successfully established session via {label} ({impersonation})")
                        return session
                    else:
                        last_error = f"[{label}] Challenge submission returned status {submit_resp.status_code}"
                        await session.close()
                        continue
                else:
                    print(f"[SESSION] Established session directly (no challenge) via {label} ({impersonation})")
                    return session
                    
            except Exception as e:
                last_error = f"[{label}] {e}"
                if session:
                    try:
                        await session.close()
                    except:
                        pass
                continue
                
    raise Exception(f"Failed to establish Reddit session. Last error: {last_error}")

async def stealth_fetch(
    url: str,
    method: str = "GET",
    allow_redirects: bool = True,
    timeout: float = 25.0,
    session: Optional[cffi_requests.AsyncSession] = None,
) -> cffi_requests.Response:
    """Unified fetch using curl_cffi with browser impersonation, proxy support, and direct fallback."""
    headers = {
        "Accept": "application/json, text/html, */*;q=0.9",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Connection": "keep-alive",
        "Referer": "https://www.reddit.com/",
        "Sec-Ch-Ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Platform": '"Windows"',
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    }

    if session:
        # Re-use existing session. Cookies are managed by session.cookies.
        return await session.request(
            method=method,
            url=url,
            headers=headers,
            allow_redirects=allow_redirects,
            timeout=timeout,
        )

    # Fallback when no session is passed (creating a transient session)
    proxy = get_healthy_proxy()
    configs = []
    if proxy:
        configs.append(({"http": proxy, "https": proxy}, "Proxy"))
    configs.append((None, "Direct"))
    
    # Cookies for transient session
    cookie_parts = ["over18=1"]
    session_cookie = os.environ.get("REDDIT_SESSION_COOKIE") or os.environ.get("REDDIT_SESSION")
    if session_cookie:
        cookie_parts.append(f"reddit_session={session_cookie}")
    else:
        cookie_parts.append("csv=1")
    headers["Cookie"] = "; ".join(cookie_parts)
    
    last_error = None
    for proxies_config, label in configs:
        current_timeout = 8.0 if label == "Proxy" else timeout
        for impersonation in IMPERSONATIONS:
            try:
                async with cffi_requests.AsyncSession(
                    impersonate=impersonation,
                    proxies=proxies_config,
                    verify=False,
                    timeout=current_timeout,
                ) as sess:
                    resp = await sess.request(
                        method=method,
                        url=url,
                        headers=headers,
                        allow_redirects=allow_redirects,
                        timeout=current_timeout,
                    )
                
                if resp.status_code == 403:
                    last_error = f"[{label}] 403 Forbidden (Blocked by Network Security)"
                    continue
                
                body_lower = resp.text[:500].lower() if resp.text else ""
                if "just a moment" in body_lower or "challenge" in body_lower:
                    last_error = f"[{label}] Cloudflare Challenge detected"
                    continue
                
                return resp
            except Exception as e:
                last_error = f"[{label}] {e}"
                continue
                
    raise Exception(f"All fetch attempts failed. Last error: {last_error}")

async def fetch_author_from_archive(content_id: str, content_type: str) -> Optional[str]:
    """Query Pullpush public archive database to find authors of deleted or removed posts/comments."""
    try:
        if content_type == "post":
            urls = [
                f"https://api.pullpush.io/reddit/submission/search?ids={content_id}",
                f"https://api.pullpush.io/reddit/submission/search?ids=t3_{content_id}"
            ]
        else:
            urls = [
                f"https://api.pullpush.io/reddit/comment/search?ids={content_id}",
                f"https://api.pullpush.io/reddit/comment/search?ids=t1_{content_id}"
            ]
            
        proxy = get_healthy_proxy()
        proxies_config = {"http": proxy, "https": proxy} if proxy else None
        
        for url in urls:
            # Try direct (no proxy) first since pullpush doesn't block direct requests
            # and proxies often time out. Fall back to proxy if direct fails.
            for use_proxy in [False, True]:
                if use_proxy and not proxy:
                    continue
                current_proxies = proxies_config if use_proxy else None
                try:
                    async with cffi_requests.AsyncSession(
                        impersonate="chrome120",
                        proxies=current_proxies,
                        verify=False,
                        timeout=5.0,
                    ) as session:
                        resp = await session.get(url)
                        if resp.status_code == 200:
                            data = resp.json()
                            results = data.get("data", [])
                            if results:
                                author = results[0].get("author")
                                if author and author not in ("[deleted]", "[removed]", "None", ""):
                                    print(f"[ARCHIVE] Found author '{author}' for {content_type} {content_id} (proxy={use_proxy})")
                                    return author
                            # If request succeeded but returned no data, no need to retry with proxy
                            break
                except Exception as e:
                    print(f"[ARCHIVE] Pullpush request failed for {url} (proxy={use_proxy}): {e}")
    except Exception as e:
        print(f"[ARCHIVE] Error in fetch_author_from_archive: {e}")
    return None

# ---------- URL CHECKING ----------
def detect_url_type(url: str) -> str:
    clean = url.split("?")[0].rstrip("/")
    if "/comment/" in clean:
        return "comment"
    return "post"

async def check_single_url(url: str, session: Optional[cffi_requests.AsyncSession] = None) -> dict:
    """Check a single URL and return result."""
    cache_key = f"url:{url}"
    cached = cache_get(cache_key)
    if cached:
        return cached
    
    try:
        # Resolve shortlinks (redd.it or /s/ shared links)
        resolved = url
        if "redd.it" in url or "/s/" in url:
            try:
                # Use GET with allow_redirects=False to only fetch the redirect header (saves 99.9% bandwidth!)
                resp = await stealth_fetch(url, method="GET", allow_redirects=False, timeout=10.0, session=session)
                if resp.status_code in (301, 302, 307, 308):
                    loc = resp.headers.get("location") or resp.headers.get("Location")
                    if loc:
                        if loc.startswith("/"):
                            loc = "https://www.reddit.com" + loc
                        resolved = loc
                else:
                    final_url = str(resp.url)
                    if "redd.it" not in final_url and "/s/" not in final_url:
                        resolved = final_url
            except Exception as e:
                print(f"[RESOLVER] Shortlink resolution failed for {url}: {e}")
        
        clean = resolved.split("?")[0].rstrip("/")
        url_type = detect_url_type(clean)
        
        # Parse post/comment IDs
        if url_type == "post":
            match = re.search(r'/comments/([^/]+)', clean)
            if not match:
                raise ValueError("Invalid post URL: Could not extract post ID")
            post_id = match.group(1)
            sub_match = re.search(r'/r/([^/]+)', clean)
            subreddit = sub_match.group(1) if sub_match else "all"
            
            fetch_url = f"https://old.reddit.com/r/{subreddit}/comments/{post_id}/.json?limit=0&raw_json=1"
            
            # GET full metadata directly
            try:
                resp = await stealth_fetch(fetch_url, timeout=20.0, session=session)
                if resp.status_code == 404:
                    archive_author = await fetch_author_from_archive(post_id, "post")
                    result = {
                        "url": url, 
                        "type": "post", 
                        "status": "deleted", 
                        "data": {
                            "subreddit": subreddit,
                            "author": archive_author
                        }
                    }
                    cache_set(cache_key, result)
                    return result
                if resp.status_code == 403:
                    result = {"url": url, "type": "post", "status": "removed", "data": {"subreddit": subreddit}, "error": "Access Forbidden (Private Subreddit)"}
                    cache_set(cache_key, result)
                    return result
                
                data = resp.json()
                
                # Verify JSON structure
                if not isinstance(data, list) or len(data) == 0 or "data" not in data[0]:
                    raise ValueError("Invalid JSON response from Reddit API")
                    
                children = data[0]["data"].get("children", [])
                if not children:
                    archive_author = await fetch_author_from_archive(post_id, "post")
                    result = {
                        "url": url, 
                        "type": "post", 
                        "status": "deleted", 
                        "data": {
                            "subreddit": subreddit,
                            "author": archive_author
                        }
                    }
                    cache_set(cache_key, result)
                    return result
                    
                post_data = children[0]["data"]
                
                removed_by = post_data.get("removed_by_category")
                author = post_data.get("author")
                selftext = post_data.get("selftext", "")
                is_robot_indexable = post_data.get("is_robot_indexable", True)
                
                if author == "[deleted]":
                    status = "deleted"
                    archive_author = await fetch_author_from_archive(post_id, "post")
                    if archive_author:
                        author = archive_author
                elif removed_by == "spam":
                    status = "spam"
                elif removed_by:
                    status = "removed"
                elif selftext == "[removed]":
                    status = "removed"
                elif not is_robot_indexable:
                    status = "removed"
                else:
                    status = "live"
                
                result = {
                    "url": url,
                    "type": "post",
                    "status": status,
                    "data": {
                        "author": author,
                        "subreddit": post_data.get("subreddit") or subreddit,
                        "title": post_data.get("title"),
                        "score": post_data.get("score", 0),
                        "num_comments": post_data.get("num_comments", 0),
                        "created_utc": post_data.get("created_utc"),
                    }
                }
                cache_set(cache_key, result)
                return result
            except Exception as e:
                return {"url": url, "type": "post", "status": "error", "error": str(e)}
        
        else:  # comment
            match = re.search(r'/comments/([^/]+)/[^/]+/([^/]+)', clean)
            if not match:
                raise ValueError("Invalid comment URL: Could not parse post and comment ID")
            post_id, comment_id = match.groups()
            sub_match = re.search(r'/r/([^/]+)', clean)
            subreddit = sub_match.group(1) if sub_match else "all"
            
            fetch_url = f"https://old.reddit.com/r/{subreddit}/comments/{post_id}/_/{comment_id}.json?limit=0&context=0&raw_json=1"
            
            try:
                resp = await stealth_fetch(fetch_url, timeout=20.0, session=session)
                if resp.status_code == 404:
                    archive_author = await fetch_author_from_archive(comment_id, "comment")
                    result = {
                        "url": url, 
                        "type": "comment", 
                        "status": "deleted", 
                        "data": {
                            "subreddit": subreddit,
                            "author": archive_author
                        }
                    }
                    cache_set(cache_key, result)
                    return result
                    
                data = resp.json()
                
                # Check comment post status
                post_data = data[0]["data"]["children"][0]["data"]
                post_status = "deleted" if post_data.get("author") == "[deleted]" else (
                    "removed" if post_data.get("removed_by_category") else "active"
                )
                
                # Walk comment tree to locate target comment ID
                comment_data = walk_comment_tree(data[1]["data"]["children"], comment_id)
                if not comment_data:
                    archive_author = await fetch_author_from_archive(comment_id, "comment")
                    result = {
                        "url": url, 
                        "type": "comment", 
                        "status": "deleted", 
                        "data": {
                            "subreddit": subreddit,
                            "author": archive_author
                        }
                    }
                    cache_set(cache_key, result)
                    return result
                
                body = comment_data.get("body", "")
                author = comment_data.get("author")
                
                # Check for deleted author first before reassigning
                is_deleted = (author == "[deleted]" or body == "[deleted]")
                
                if author == "[deleted]":
                    archive_author = await fetch_author_from_archive(comment_id, "comment")
                    if archive_author:
                        author = archive_author
                
                if body == "[removed]":
                    status = "removed"
                elif is_deleted:
                    status = "deleted"
                else:
                    status = "live"
                
                result = {
                    "url": url,
                    "type": "comment",
                    "status": status,
                    "data": {
                        "author": author,
                        "subreddit": comment_data.get("subreddit") or subreddit,
                        "body_preview": body[:120] if body else None,
                        "score": comment_data.get("score", 0),
                        "created_utc": comment_data.get("created_utc"),
                        "post_status": post_status,
                    }
                }
                cache_set(cache_key, result)
                return result
            except Exception as e:
                return {"url": url, "type": "comment", "status": "error", "error": str(e)}
                
    except Exception as e:
        return {"url": url, "type": "unknown", "status": "error", "error": str(e)}

def walk_comment_tree(tree_list, target_id):
    for item in tree_list:
        if not isinstance(item, dict):
            continue
        if item.get("kind") == "more":
            continue
        data = item.get("data", {})
        if data.get("id") == target_id:
            return data
        replies = data.get("replies")
        if isinstance(replies, dict) and "data" in replies:
            found = walk_comment_tree(replies["data"]["children"], target_id)
            if found:
                return found
    return None

async def fetch_author(username: str, session: Optional[cffi_requests.AsyncSession] = None) -> dict:
    """Fetch author account data to check for active/suspended/deleted status."""
    cache_key = f"author:{username}"
    cached = cache_get(cache_key)
    if cached:
        return cached
    
    try:
        fetch_url = f"https://old.reddit.com/user/{username}/about.json?raw_json=1"
        resp = await stealth_fetch(fetch_url, timeout=15.0, session=session)
        
        if resp.status_code == 200:
            data = resp.json().get("data", {})
            # A user is suspended if is_suspended is True or if subreddit is None (shadowbanned/suspended on legacy API)
            is_suspended = data.get("is_suspended", False)
            subreddit_data = data.get("subreddit")
            
            status = "active"
            if is_suspended or subreddit_data is None:
                status = "suspended"
                
            result = {
                "username": data.get("name", username),
                "status": status,
                "total_karma": data.get("total_karma", 0),
                "created_utc": data.get("created_utc"),
                "avatar_url": data.get("icon_img"),
            }
        elif resp.status_code == 404:
            # If the user returns 404 and the username is not literally "[deleted]",
            # they might be suspended/banned/shadowbanned or deleted. 
            # We can distinguish by doing a quick fetch of the HTML profile page.
            if username.lower() == "[deleted]":
                result = {"username": username, "status": "deleted"}
            else:
                try:
                    html_url = f"https://old.reddit.com/user/{username}/"
                    html_resp = await stealth_fetch(html_url, timeout=10.0, session=session)
                    html_text = html_resp.text.lower()
                    if "suspended" in html_text or "suspension" in html_text:
                        result = {"username": username, "status": "suspended"}
                    else:
                        result = {"username": username, "status": "deleted"}
                except Exception:
                    # Fallback if HTML fetch fails
                    result = {"username": username, "status": "deleted"}
        else:
            result = {"username": username, "status": "error"}
        
        cache_set(cache_key, result)
        return result
    except Exception as e:
        return {"username": username, "status": "error", "error": str(e)}

# ---------- BULK PROCESSING ----------
async def process_bulk_job(job_id: str, urls: list, include_author: bool):
    job = _bulk_jobs.get(job_id)
    if not job:
        return
    
    results = []
    total = len(urls)
    chunk_size = 15  # Process in small chunks to avoid rate limits
    
    # Establish a shared session for the duration of the job
    proxy = get_healthy_proxy()
    session = None
    try:
        session = await establish_session(proxy)
    except Exception as e:
        print(f"[SESSION] Failed to establish cookies via challenge solver: {e}. Falling back to uninitialized session.")
        # Fallback: create raw transient session
        session = cffi_requests.AsyncSession(
            impersonate="chrome120",
            proxies={"http": proxy, "https": proxy} if proxy else None,
            verify=False,
            timeout=25.0
        )
        # Pre-populate basic cookies
        session.cookies.set("over18", "1")
        session.cookies.set("csv", "1")
        session_cookie = os.environ.get("REDDIT_SESSION_COOKIE") or os.environ.get("REDDIT_SESSION")
        if session_cookie:
            session.cookies.set("reddit_session", session_cookie)
            
    try:
        for i in range(0, total, chunk_size):
            chunk = urls[i:i+chunk_size]
            tasks = [check_single_url(u, session=session) for u in chunk]
            chunk_results = await asyncio.gather(*tasks, return_exceptions=False)
            
            for r in chunk_results:
                if isinstance(r, dict):
                    results.append(r)
                else:
                    results.append({"url": str(r), "status": "error", "error": str(r)})
            
            job["progress"] = min(i + len(chunk), total)
            job["results"] = results
            
            # Polite spacing between requests to old.reddit
            if i + chunk_size < total:
                await asyncio.sleep(4)
        
        # Fetch authors if requested
        if include_author:
            authors = list({
                r.get("data", {}).get("author")
                for r in results
                if r.get("data") and r["data"].get("author")
                and r["data"]["author"] not in ("[deleted]", None)
            })
            
            author_cache = {}
            for idx, author in enumerate(authors):
                # Polite spacing between user profile checks
                if idx > 0 and idx % 4 == 0:
                    await asyncio.sleep(2)
                try:
                    author_data = await fetch_author(author, session=session)
                    if author_data:
                        author_cache[author] = author_data
                except Exception as e:
                    print(f"[AUTHOR] Error checking user {author}: {e}")
            
            for r in results:
                author = r.get("data", {}).get("author")
                if author and author in author_cache:
                    r["author"] = author_cache[author]
                elif author:
                    r["author"] = {"username": author, "status": "unknown"}
                    
    finally:
        try:
            await session.close()
        except Exception as e:
            print(f"[SESSION] Error closing session: {e}")
            
    job["status"] = "done"
    job["progress"] = total
    job["results"] = results

# ---------- API ENDPOINTS ----------
class BulkCheckRequest(BaseModel):
    urls: List[str]
    include_author: bool = True

@app.post("/api/bulk/check")
async def bulk_check(payload: BulkCheckRequest, background_tasks: BackgroundTasks):
    urls = payload.urls
    include_author = payload.include_author
    
    urls = [u.strip() for u in urls if isinstance(u, str) and u.strip()][:500]
    
    if not urls:
        return JSONResponse({"error": "No URLs provided"}, status_code=400)
    
    job_id = str(uuid.uuid4())
    _bulk_jobs[job_id] = {
        "status": "running",
        "progress": 0,
        "total": len(urls),
        "results": [],
        "created_at": time.time()
    }
    
    background_tasks.add_task(process_bulk_job, job_id, urls, include_author)
    return {"job_id": job_id, "status": "accepted", "total": len(urls)}

@app.get("/api/bulk/status/{job_id}")
async def bulk_status(job_id: str):
    job = _bulk_jobs.get(job_id)
    if not job:
        return JSONResponse({"error": "Job not found"}, status_code=404)
    
    # Return current list of results during execution to allow progressive frontend rendering
    return {
        "job_id": job_id,
        "status": job["status"],
        "progress": job["progress"],
        "total": job["total"],
        "results": job["results"]
    }

@app.get("/health")
async def health():
    return {
        "status": "ok",
        "proxy": bool(PROXIES),
        "cached_keys_count": len(_cache_store),
        "active_jobs_count": len([j for j in _bulk_jobs.values() if j["status"] == "running"])
    }

@app.get("/debug/pullpush/{post_id}")
async def debug_pullpush(post_id: str, comment_id: str = None):
    """Debug endpoint to test Pullpush archive retrieval."""
    content_type = "comment" if comment_id else "post"
    content_id = comment_id if comment_id else post_id
    result = await fetch_author_from_archive(content_id, content_type)
    return {
        "success": bool(result),
        "author": result,
        "content_type": content_type,
        "content_id": content_id
    }

# ---------- STARTUP ----------
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("api:app", host="0.0.0.0", port=7860, reload=True)
