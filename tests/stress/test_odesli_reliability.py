import hashlib
import json
import os
import random
import socket
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request

import pytest


ORIGIN = "http://localhost:4173"
TRACKS = [
    "Blinding Lights The Weeknd",
    "Levitating Dua Lipa",
    "As It Was Harry Styles",
    "Flowers Miley Cyrus",
    "Anti-Hero Taylor Swift",
    "Bad Guy Billie Eilish",
    "Shape of You Ed Sheeran",
    "Uptown Funk Mark Ronson Bruno Mars",
    "Get Lucky Daft Punk Pharrell Williams",
    "Starboy The Weeknd Daft Punk",
    "Someone Like You Adele",
    "Rolling in the Deep Adele",
    "drivers license Olivia Rodrigo",
    "good 4 u Olivia Rodrigo",
    "Watermelon Sugar Harry Styles",
    "Stay The Kid LAROI Justin Bieber",
    "Peaches Justin Bieber Daniel Caesar Giveon",
    "Circles Post Malone",
    "Sunflower Post Malone Swae Lee",
    "HUMBLE Kendrick Lamar",
    "SICKO MODE Travis Scott",
    "God's Plan Drake",
    "One Dance Drake Wizkid Kyla",
    "Dance Monkey Tones and I",
    "Senorita Shawn Mendes Camila Cabello",
    "Shallow Lady Gaga Bradley Cooper",
    "Believer Imagine Dragons",
    "Radioactive Imagine Dragons",
    "Counting Stars OneRepublic",
    "Viva La Vida Coldplay",
    "Yellow Coldplay",
    "Bohemian Rhapsody Queen",
    "Don't Stop Me Now Queen",
    "Billie Jean Michael Jackson",
    "Smells Like Teen Spirit Nirvana",
    "Wonderwall Oasis",
    "Mr. Brightside The Killers",
    "Take Me Out Franz Ferdinand",
    "Seven Nation Army The White Stripes",
    "Lose Yourself Eminem",
    "Hey Ya Outkast",
    "Crazy Gnarls Barkley",
    "Paper Planes M.I.A.",
    "Royals Lorde",
    "Riptide Vance Joy",
    "Ho Hey The Lumineers",
    "Electric Feel MGMT",
    "Sweet Disposition The Temper Trap",
    "Tame Impala The Less I Know The Better",
    "Redbone Childish Gambino",
]


def unused_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def read_json(url, headers=None, timeout=20):
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return response.status, json.loads(response.read().decode("utf-8"))


def solve_pow(seed, difficulty):
    prefix = "0" * difficulty
    nonce = 0
    while True:
        candidate = str(nonce)
        digest = hashlib.sha256((seed + candidate).encode("utf-8")).hexdigest()
        if digest.startswith(prefix):
            return candidate
        nonce += 1


def api_get(base_url, path, params):
    challenge_url = f"{base_url}/api/challenge"
    _, challenge = read_json(challenge_url, headers={"Origin": ORIGIN})
    nonce = solve_pow(challenge["seed"], challenge["difficulty"])
    url = f"{base_url}{path}?{urllib.parse.urlencode(params)}"
    headers = {
        "Origin": ORIGIN,
        "Sec-Fetch-Site": "same-site",
        "Sec-Fetch-Mode": "cors",
        "X-LP-Seed": challenge["seed"],
        "X-LP-Nonce": nonce,
    }
    return read_json(url, headers=headers, timeout=45)


@pytest.fixture(scope="session")
def linkpark_server():
    port = unused_port()
    env = os.environ.copy()
    env.update(
        {
            "PORT": str(port),
            "SERVICE": ORIGIN,
            "TFKEY": "tinyfish-simulator",
            "TINYFISH_SIMULATOR": "1",
            "POW_DIFFICULTY": "2",
            "API_RATE_LIMIT_MAX": "500",
            "SESSION_RATE_LIMIT_MAX": "500",
        }
    )
    proc = subprocess.Popen(
        ["node", "server.js"],
        cwd=os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    base_url = f"http://127.0.0.1:{port}"
    deadline = time.time() + 20
    while time.time() < deadline:
        if proc.poll() is not None:
            output = proc.stdout.read() if proc.stdout else ""
            pytest.fail(f"server exited early with {proc.returncode}\n{output}")
        try:
            read_json(f"{base_url}/api/challenge", headers={"Origin": ORIGIN}, timeout=1)
            break
        except Exception:
            time.sleep(0.2)
    else:
        proc.terminate()
        pytest.fail("server did not start within 20 seconds")

    yield base_url

    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()


@pytest.mark.skipif(
    os.environ.get("RUN_LINKPARK_STRESS") != "1",
    reason="set RUN_LINKPARK_STRESS=1 to run the 50-track external Odesli stress test",
)
def test_odesli_and_apple_music_stay_reliable_over_random_tracks(linkpark_server):
    count = int(os.environ.get("LINKPARK_STRESS_COUNT", "50"))
    duration = float(os.environ.get("LINKPARK_STRESS_DURATION_SECONDS", "600"))
    country = os.environ.get("LINKPARK_STRESS_COUNTRY", "US")
    rng = random.Random(os.environ.get("LINKPARK_STRESS_SEED", "linkpark"))
    tracks = rng.sample(TRACKS, k=min(count, len(TRACKS)))
    pause = duration / max(len(tracks), 1)
    failures = []

    for index, query in enumerate(tracks, start=1):
        started = time.monotonic()
        try:
            status, data = api_get(
                linkpark_server,
                "/api/resolve",
                {"query": query, "country": country},
            )
            links = data.get("links") or {}
            if status != 200:
                failures.append(f"{query}: HTTP {status}")
            if not links.get("appleMusic"):
                failures.append(f"{query}: missing Apple Music link; response={data}")
            if not data.get("preview"):
                failures.append(f"{query}: missing Apple preview; response={data}")
            if not (links.get("spotify") or links.get("youtubeMusic") or links.get("youtube")):
                failures.append(f"{query}: Odesli did not enrich any secondary platform; response={data}")
        except urllib.error.HTTPError as exc:
            failures.append(f"{query}: HTTP {exc.code} {exc.read().decode('utf-8', 'replace')}")
        except Exception as exc:
            failures.append(f"{query}: {type(exc).__name__}: {exc}")

        if index < len(tracks):
            elapsed = time.monotonic() - started
            time.sleep(max(0, pause - elapsed))

    assert not failures, "\n".join(failures)
