#!/usr/bin/env python3
"""Loopit 运营数据查询引擎。

按 UID / PID 查询真实作品数据，底层走 loopit-data-ops 的 OpenClaw gateway 打到
阿里云 MaxCompute。每个子命令构建一段经过审计口径的 SQL，执行后整理成干净的
JSON 给上层（agent 工具 / 人）使用。

子命令：
  works        --uid <uid>            某创作者的作品列表
  profile      --pid <pid>            单个作品的基础画像
  consumption  --pid <pid>            单个作品的逐日消费数据（曝光/播放/点赞/评论/收藏）
  comments     --pid <pid>            单个作品的评论（高赞 hot / 最新 latest）
  prompt       --pid <pid>            单个作品的创作 prompt 与 agent 回复
  overview     --pid <pid>            一次拉齐画像+消费概览+高赞评论+初始 prompt

所有时间口径均为 UTC+8。消费数据来自看板宽表 dws_ub_uid_pid_wide_hi（dashboard 口径）。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

# --- 定位 loopit-data-ops gateway（真实数据出口） ---------------------------------
DATA_OPS_DIR = Path(
    os.environ.get("LOOPIT_DATA_OPS_DIR")
    or (Path.home() / ".claude" / "skills" / "loopit-data-ops")
).expanduser()
DATA_OPS_SCRIPTS = DATA_OPS_DIR / "scripts"
GATEWAY_TOOL = DATA_OPS_SCRIPTS / "gateway_tool.py"

if str(DATA_OPS_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(DATA_OPS_SCRIPTS))

try:
    from sql_utils import normalize_sql  # type: ignore
except Exception:  # pragma: no cover - sql_utils 缺失时退化为本地极简归一化
    def normalize_sql(sql: str) -> str:
        return " ".join(sql.replace("\n", " ").split()).rstrip(";")

TZ8 = timezone(timedelta(hours=8))

# --- 枚举口径表 ------------------------------------------------------------------
POST_STATUS = {1: "草稿箱", 2: "私有", 3: "公开"}
GRADE = {1: "B", 2: "B+", 3: "A", 4: "A+", 5: "S", 6: "S+"}
TASK_STATUS = {0: "执行中", 1: "失败", 2: "成功"}


class QueryError(Exception):
    """查询执行失败。"""


# --- 输入校验：pid/uid 只允许安全字符，避免拼进 SQL 出问题 -----------------------
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_DT_RE = re.compile(r"^\d{8}$")


def safe_id(value: str, label: str) -> str:
    value = (value or "").strip()
    # 容错：传进来的是分享链接/带路径时（如 https://share.loopit.me/game/<PID>），取最后一段
    if "/" in value:
        value = value.split("#", 1)[0].split("?", 1)[0].rstrip("/").split("/")[-1]
    if not _ID_RE.match(value):
        raise QueryError(f"{label} 不合法（只允许字母/数字/下划线/连字符）：{value!r}")
    return value


def safe_dt(value: str, label: str) -> str:
    value = (value or "").strip()
    if not _DT_RE.match(value):
        raise QueryError(f"{label} 需要 yyyymmdd 格式：{value!r}")
    return value


def today8() -> datetime:
    return datetime.now(TZ8)


def to_yyyymmdd(d: datetime) -> str:
    return d.strftime("%Y%m%d")


# --- gateway 执行 ----------------------------------------------------------------
def run_sql(sql: str, timeout_ms: int) -> dict:
    """执行只读 SQL，返回 {columns, rowCount, rows, truncated}。"""
    if not GATEWAY_TOOL.exists():
        raise QueryError(
            f"找不到 gateway: {GATEWAY_TOOL}。"
            "请确认 loopit-data-ops skill 已安装，或设置 LOOPIT_DATA_OPS_DIR。"
        )
    sql_send = normalize_sql(sql)
    args_json = json.dumps({"sql": sql_send}, ensure_ascii=False)
    cmd = [
        sys.executable,
        str(GATEWAY_TOOL),
        "aliyun_mc_query",
        "--args-json",
        args_json,
        "--timeout",
        str(timeout_ms),
    ]
    proc = subprocess.run(cmd, text=True, capture_output=True, env=os.environ.copy())
    if proc.returncode != 0:
        msg = (proc.stderr or proc.stdout or "").strip()
        raise QueryError(f"gateway 执行失败：{msg[:1200]}")
    try:
        envelope = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise QueryError(f"gateway 返回非 JSON：{exc}; raw={proc.stdout[:500]}")

    data = (envelope.get("details") or {}).get("json")
    if data is None:
        content = envelope.get("content") or []
        if content and isinstance(content[0], dict) and "text" in content[0]:
            try:
                data = json.loads(content[0]["text"])
            except json.JSONDecodeError:
                data = None
    if not isinstance(data, dict) or "rows" not in data:
        raise QueryError(f"无法解析查询结果：{json.dumps(envelope, ensure_ascii=False)[:500]}")
    return data


# --- 取数小工具 ------------------------------------------------------------------
def num(value) -> float:
    try:
        if value is None:
            return 0.0
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def ratio(numer: float, denom: float, digits: int = 4):
    if not denom:
        return None
    return round(numer / denom, digits)


def enum_label(value, table: dict):
    try:
        return table.get(int(value))
    except (TypeError, ValueError):
        return None


# ================================ 子命令 =========================================
def q_works(args) -> dict:
    uid = safe_id(args.uid, "uid")
    limit = max(1, min(args.limit, 200))
    where = [f"dt = max_pt('loopit.dim_cont_project')", f"uid = '{uid}'"]
    if args.public:
        where.append("post_status = 3")
    sql = (
        "SELECT pid, project_name, post_status, project_type, is_original, "
        "play_type_l0, theme, first_publish_time, create_time "
        "FROM loopit.dim_cont_project "
        f"WHERE {' AND '.join(where)} "
        f"ORDER BY first_publish_time DESC LIMIT {limit}"
    )
    res = run_sql(sql, args.timeout)
    works = []
    for r in res["rows"]:
        works.append(
            {
                "pid": r.get("pid"),
                "title": r.get("project_name") or None,
                "status": enum_label(r.get("post_status"), POST_STATUS),
                "type": r.get("project_type"),
                "is_original": bool(num(r.get("is_original"))),
                "play_type": r.get("play_type_l0") or None,
                "theme": r.get("theme") or None,
                "first_publish_time": r.get("first_publish_time") or None,
                "create_time": r.get("create_time") or None,
            }
        )
    return {
        "kind": "works",
        "query": {"uid": uid, "public_only": bool(args.public), "limit": limit},
        "source": {"table": "loopit.dim_cont_project", "tz": "UTC+8"},
        "data": {"count": len(works), "works": works},
        "note": "标题为空是常见数据现象；可用 prompt 子命令拿创作 prompt 当作品名参考。",
    }


def q_profile(args) -> dict:
    pid = safe_id(args.pid, "pid")
    sql = (
        "SELECT pid, uid, project_name, post_status, project_type, is_original, project_source, "
        "play_type_l0, play_type_l1, art_style, theme, vibe, format_social, interaction_type, "
        "grade, is_multiplayer, remix_depth, create_time, first_publish_time "
        "FROM loopit.dim_cont_project "
        f"WHERE dt = max_pt('loopit.dim_cont_project') AND pid = '{pid}' LIMIT 5"
    )
    res = run_sql(sql, args.timeout)
    if not res["rows"]:
        raise QueryError(f"作品不存在或维表里查不到：{pid}")
    r = res["rows"][0]
    profile = {
        "pid": r.get("pid"),
        "uid": r.get("uid"),
        "title": r.get("project_name") or None,
        "status": enum_label(r.get("post_status"), POST_STATUS),
        "type": r.get("project_type"),
        "is_original": bool(num(r.get("is_original"))),
        "project_source": r.get("project_source") or None,
        "grade": enum_label(r.get("grade"), GRADE),
        "is_multiplayer": bool(num(r.get("is_multiplayer"))),
        "remix_depth": int(num(r.get("remix_depth"))),
        "tags": {
            "play_type_l0": r.get("play_type_l0") or None,
            "play_type_l1": r.get("play_type_l1") or None,
            "art_style": r.get("art_style") or None,
            "theme": r.get("theme") or None,
            "vibe": r.get("vibe") or None,
            "format_social": r.get("format_social") or None,
            "interaction_type": r.get("interaction_type") or None,
        },
        "create_time": r.get("create_time") or None,
        "first_publish_time": r.get("first_publish_time") or None,
    }
    out = {
        "kind": "profile",
        "query": {"pid": pid},
        "source": {"table": "loopit.dim_cont_project", "tz": "UTC+8"},
        "data": profile,
    }
    if args.uid:
        owner = safe_id(args.uid, "uid")
        out["data"]["ownership_match"] = profile["uid"] == owner
    return out


def consumption_window(args) -> tuple[str, str]:
    if args.start or args.end:
        end = safe_dt(args.end, "end") if args.end else to_yyyymmdd(today8() - timedelta(days=1))
        start = safe_dt(args.start, "start") if args.start else end
        return start, end
    # 默认窗口：截止到昨天（今天分区通常还没落），往前 days 天
    end_d = today8() - timedelta(days=1)
    start_d = end_d - timedelta(days=max(1, args.days) - 1)
    return to_yyyymmdd(start_d), to_yyyymmdd(end_d)


def q_consumption(args) -> dict:
    pid = safe_id(args.pid, "pid")
    start, end = consumption_window(args)
    sql = (
        "SELECT dt, SUM(project_exposure_cnt) AS vv, COUNT(DISTINCT uid) AS viewer_uv, "
        "SUM(project_play_cnt) AS play_cnt, SUM(project_play_time_10s_cnt) AS play_10s_cnt, "
        "ROUND(SUM(project_play_duration_second), 1) AS play_dur_sec, "
        "SUM(project_like_cnt) AS like_cnt, SUM(project_comment_cnt) AS comment_cnt, "
        "SUM(pub_proj_feed_favorite_cnt) - SUM(pub_proj_feed_unfavorite_cnt) AS favorite_net "
        "FROM loopit.dws_ub_uid_pid_wide_hi "
        f"WHERE dt BETWEEN '{start}' AND '{end}' AND pid = '{pid}' "
        "GROUP BY dt ORDER BY dt LIMIT 400"
    )
    res = run_sql(sql, args.timeout)
    daily = []
    for r in res["rows"]:
        vv = int(num(r.get("vv")))
        play = int(num(r.get("play_cnt")))
        daily.append(
            {
                "date": r.get("dt"),
                "vv": vv,
                "viewer_uv": int(num(r.get("viewer_uv"))),
                "play_cnt": play,
                "play_10s_cnt": int(num(r.get("play_10s_cnt"))),
                "play_dur_sec": round(num(r.get("play_dur_sec")), 1),
                "like_cnt": int(num(r.get("like_cnt"))),
                "comment_cnt": int(num(r.get("comment_cnt"))),
                "favorite_net": int(num(r.get("favorite_net"))),
                "play_10s_rate": ratio(num(r.get("play_10s_cnt")), vv, 4),
            }
        )
    tot_vv = sum(d["vv"] for d in daily)
    tot_play = sum(d["play_cnt"] for d in daily)
    tot_10s = sum(d["play_10s_cnt"] for d in daily)
    tot_dur = sum(d["play_dur_sec"] for d in daily)
    summary = {
        "days": len(daily),
        "total_vv": tot_vv,
        "viewer_uv_sum_daily": sum(d["viewer_uv"] for d in daily),
        "peak_daily_viewer_uv": max((d["viewer_uv"] for d in daily), default=0),
        "total_play": tot_play,
        "total_play_10s": tot_10s,
        "total_like": sum(d["like_cnt"] for d in daily),
        "total_comment": sum(d["comment_cnt"] for d in daily),
        "total_favorite_net": sum(d["favorite_net"] for d in daily),
        "play_rate": ratio(tot_play, tot_vv),
        "play_10s_rate": ratio(tot_10s, tot_vv),
        "like_rate": ratio(sum(d["like_cnt"] for d in daily), tot_vv),
        "avg_play_sec": ratio(tot_dur, tot_play, 1),
    }
    return {
        "kind": "consumption",
        "query": {"pid": pid, "start": start, "end": end},
        "source": {
            "table": "loopit.dws_ub_uid_pid_wide_hi",
            "tz": "UTC+8",
            "caliber": "看板宽表口径（dashboard proxy）；曝光=project_exposure_cnt 计 VV",
        },
        "data": {"summary": summary, "daily": daily},
        "note": "viewer_uv_sum_daily 为逐日去重相加，跨日会重复；窗口默认截止到昨天。",
    }


def q_comments(args) -> dict:
    pid = safe_id(args.pid, "pid")
    limit = max(1, min(args.limit, 200))
    sort = args.sort
    order = "like_count DESC, create_time DESC" if sort == "hot" else "create_time DESC"
    where = [
        "dt = max_pt('loopit.ods_t_comment')",
        f"project_id = '{pid}'",
        "status = 0",
    ]
    if not args.include_replies:
        where.append("root_id = 0")
    sql = (
        "SELECT id, user_id, content, like_count, reply_count, create_time, root_id, parent_id "
        "FROM loopit.ods_t_comment "
        f"WHERE {' AND '.join(where)} "
        f"ORDER BY {order} LIMIT {limit}"
    )
    res = run_sql(sql, args.timeout)
    comments = []
    for r in res["rows"]:
        comments.append(
            {
                "id": r.get("id"),
                "user_id": r.get("user_id"),
                "content": r.get("content"),
                "like_count": int(num(r.get("like_count"))),
                "reply_count": int(num(r.get("reply_count"))),
                "create_time": r.get("create_time"),
                "is_reply": int(num(r.get("root_id"))) != 0,
            }
        )
    return {
        "kind": "comments",
        "query": {
            "pid": pid,
            "sort": sort,
            "limit": limit,
            "include_replies": bool(args.include_replies),
        },
        "source": {"table": "loopit.ods_t_comment", "tz": "UTC+8"},
        "data": {"count": len(comments), "comments": comments},
        "note": "默认只取主评论(root_id=0)、已过审(status=0)；sort=hot 按赞排序，latest 按时间。",
    }


def q_prompt(args) -> dict:
    pid = safe_id(args.pid, "pid")
    rounds = max(1, min(args.rounds, 30))
    resp_cap = 1500 if not args.full else 100000
    sql = (
        "SELECT task_id, task_type, status, task_related_user_prompt, agent_response, "
        "create_time, publish_status "
        "FROM loopit.ods_loopit_game_task "
        f"WHERE dt = max_pt('loopit.ods_loopit_game_task') AND project_id = '{pid}' "
        f"ORDER BY create_time ASC LIMIT {rounds}"
    )
    res = run_sql(sql, args.timeout)
    if not res["rows"]:
        raise QueryError(f"该作品没有可查的创作任务/prompt：{pid}")
    tasks = []
    for i, r in enumerate(res["rows"], start=1):
        resp = r.get("agent_response") or ""
        truncated = len(resp) > resp_cap
        tasks.append(
            {
                "round": i,
                "task_id": r.get("task_id"),
                "task_type": r.get("task_type"),
                "status": enum_label(r.get("status"), TASK_STATUS),
                "user_prompt": r.get("task_related_user_prompt") or None,
                "agent_response": resp[:resp_cap] + ("…" if truncated else "") if resp else None,
                "agent_response_truncated": truncated,
                "create_time": r.get("create_time"),
            }
        )
    return {
        "kind": "prompt",
        "query": {"pid": pid, "rounds": rounds, "full": bool(args.full)},
        "source": {"table": "loopit.ods_loopit_game_task", "tz": "UTC+8"},
        "data": {
            "count": len(tasks),
            "initial_prompt": tasks[0]["user_prompt"] if tasks else None,
            "latest_prompt": tasks[-1]["user_prompt"] if tasks else None,
            "tasks": tasks,
        },
        "note": (
            "创作历程：每轮含用户 prompt 与 agent 实际做了什么(agent_response)。"
            "round 1 是初始 prompt，最后一轮最接近当前内容形态；"
            "可据此判断作品做了哪些功能、可能有哪些问题，再结合评论给优化方向。"
            "agent_response 默认截断，加 --full 取全文。"
        ),
    }


def q_overview(args) -> dict:
    pid = safe_id(args.pid, "pid")
    out = {
        "kind": "overview",
        "query": {"pid": pid, "days": args.days},
        "data": {},
    }
    errors = {}
    # profile
    try:
        out["data"]["profile"] = q_profile(args)["data"]
    except QueryError as exc:
        errors["profile"] = str(exc)
    # consumption summary
    try:
        cons = q_consumption(args)
        out["data"]["consumption"] = {
            "window": cons["query"],
            "summary": cons["data"]["summary"],
            "daily": cons["data"]["daily"],
        }
    except QueryError as exc:
        errors["consumption"] = str(exc)
    # top comments (hot, 5)
    try:
        c_args = argparse.Namespace(
            pid=pid, sort="hot", limit=5, include_replies=False, timeout=args.timeout
        )
        out["data"]["top_comments"] = q_comments(c_args)["data"]["comments"]
    except QueryError as exc:
        errors["top_comments"] = str(exc)
    # initial prompt
    try:
        p_args = argparse.Namespace(pid=pid, rounds=3, full=False, timeout=args.timeout)
        pr = q_prompt(p_args)["data"]
        out["data"]["prompt"] = {
            "initial_prompt": pr["initial_prompt"],
            "rounds": pr["count"],
        }
    except QueryError as exc:
        errors["prompt"] = str(exc)
    if errors:
        out["partial_errors"] = errors
    return out


# ================================ CLI ===========================================
def build_parser() -> argparse.ArgumentParser:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--pretty", action="store_true", help="美化输出 JSON")
    common.add_argument("--timeout", type=int, default=120000, help="单次查询超时(ms)")

    p = argparse.ArgumentParser(description="Loopit 运营数据查询引擎", parents=[common])
    sub = p.add_subparsers(dest="cmd", required=True)

    def add(name, help):  # 子命令共享 --pretty/--timeout，前后位置都能写
        return sub.add_parser(name, help=help, parents=[common])

    sp = add("works", "按 UID 查作品列表")
    sp.add_argument("--uid", required=True)
    sp.add_argument("--limit", type=int, default=20)
    sp.add_argument("--public", action="store_true", help="只看已公开作品(post_status=3)")
    sp.set_defaults(func=q_works)

    sp = add("profile", "按 PID 查作品画像")
    sp.add_argument("--pid", required=True)
    sp.add_argument("--uid", help="可选：校验作品是否属于该 UID")
    sp.set_defaults(func=q_profile)

    sp = add("consumption", "按 PID 查逐日消费数据")
    sp.add_argument("--pid", required=True)
    sp.add_argument("--days", type=int, default=7, help="默认窗口天数(截止昨天)")
    sp.add_argument("--start", help="起始日 yyyymmdd")
    sp.add_argument("--end", help="结束日 yyyymmdd")
    sp.set_defaults(func=q_consumption)

    sp = add("comments", "按 PID 查评论")
    sp.add_argument("--pid", required=True)
    sp.add_argument("--sort", choices=["hot", "latest"], default="hot")
    sp.add_argument("--limit", type=int, default=100)
    sp.add_argument("--include-replies", action="store_true", help="包含回复(默认只看主评论)")
    sp.set_defaults(func=q_comments)

    sp = add("prompt", "按 PID 查创作 prompt")
    sp.add_argument("--pid", required=True)
    sp.add_argument("--rounds", type=int, default=5, help="返回多少个创作轮次")
    sp.add_argument("--full", action="store_true", help="返回 agent_response 全文")
    sp.set_defaults(func=q_prompt)

    sp = add("overview", "按 PID 一次拉齐画像+消费+评论+prompt")
    sp.add_argument("--pid", required=True)
    sp.add_argument("--days", type=int, default=7)
    sp.add_argument("--start", help="起始日 yyyymmdd")
    sp.add_argument("--end", help="结束日 yyyymmdd")
    sp.add_argument("--uid", help="可选：作品归属校验")
    sp.set_defaults(func=q_overview)
    return p


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    # 给未声明对应字段的子命令补默认值，避免共享函数取属性报错
    for attr, default in (("uid", None), ("start", None), ("end", None), ("days", 7), ("full", False)):
        if not hasattr(args, attr):
            setattr(args, attr, default)
    try:
        result = args.func(args)
        result["ok"] = True
    except QueryError as exc:
        result = {"ok": False, "kind": getattr(args, "cmd", None), "error": str(exc)}
    except Exception as exc:  # pragma: no cover
        result = {"ok": False, "kind": getattr(args, "cmd", None), "error": f"未预期错误：{exc}"}
    sys.stdout.write(json.dumps(result, ensure_ascii=False, indent=2 if args.pretty else None))
    sys.stdout.write("\n")
    return 0 if result.get("ok") else 2


if __name__ == "__main__":
    raise SystemExit(main())
