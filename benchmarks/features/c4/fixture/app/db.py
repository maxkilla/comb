import sqlite3


def connect(path="app.db"):
    return sqlite3.connect(path)


def get_user(conn, name):
    cur = conn.execute(f"SELECT id, name, email FROM users WHERE name = '{name}'")
    return cur.fetchone()


def list_orders(conn, user_id):
    cur = conn.execute(f"SELECT id, total FROM orders WHERE user_id = {user_id}")
    return cur.fetchall()
