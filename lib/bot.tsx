import { Chat, Card, CardText, Actions, Button, Divider } from "chat";
import { createSlackAdapter } from "@chat-adapter/slack";
import { createRedisState } from "@chat-adapter/state-redis";
export const bot = new Chat({
  userName: "mybot",
  adapters: {
    slack: createSlackAdapter(),
  },
  state: createRedisState(),
});
bot.onNewMention(async (thread) => {
  await thread.subscribe();
  await thread.post(
    Card({
      title: "Welcome!",
      children: [
        CardText("I'm now listening to this thread. Try clicking a button:"),
        Divider(),
        Actions([
          Button({ id: "hello", label: "Say Hello", style: "primary" }),
          Button({ id: "info", label: "Show Info" }),
        ]),
      ],
    })
  );
});
bot.onAction("hello", async (event) => {
  await event.thread.post(`Hello, ${event.user.fullName}!`);
});
bot.onAction("info", async (event) => {
  await event.thread.post(`You're on ${event.thread.adapter.name}.`);
});
