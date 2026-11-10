from dataclasses import dataclass


@dataclass
class Post:
    title: str
    author: str
    tags: list
