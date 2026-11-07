package com.dsh.wechatbridge;

import org.json.JSONObject;

/**
 * 一条微信消息，字段与桥接协议 message.in 对齐。
 */
public final class WeChatMessage {

    public String msgId = "";
    public String sessionId = "";
    public String chatType = "private"; // private | group
    public String senderId = "";
    public String senderName = "";
    public String senderRemark = "";
    public String content = "";
    public String msgType = "text";
    public int rawType = 1; // 微信原始 type：1 文本 / 47 表情 / 3 图片 …
    public long timestamp = System.currentTimeMillis() / 1000L;
    public boolean isGroup = false;
    public String groupId;
    public String groupName;
    public boolean atMe = false;
    /** 图片消息：缩过的小图，base64 放进协议里给模型看 */
    public String imageBase64 = "";
    public String imageMime = "";

    public JSONObject toJson() {
        JSONObject root = new JSONObject();
        try {
            root.put("type", "message.in");
            root.put("msgId", msgId);
            root.put("sessionId", sessionId);
            root.put("chatType", chatType);
            JSONObject sender = new JSONObject();
            sender.put("id", senderId);
            sender.put("name", senderName);
            if (!senderRemark.isEmpty()) sender.put("remark", senderRemark);
            root.put("sender", sender);
            root.put("content", content);
            root.put("msgType", msgType);
            root.put("rawType", rawType);
            root.put("timestamp", timestamp);
            root.put("isGroup", isGroup);
            if (isGroup && groupId != null) {
                JSONObject group = new JSONObject();
                group.put("groupId", groupId);
                group.put("groupName", groupName == null ? groupId : groupName);
                group.put("atMe", atMe);
                root.put("groupInfo", group);
            } else {
                root.put("groupInfo", JSONObject.NULL);
            }
            if (!imageBase64.isEmpty()) {
                JSONObject image = new JSONObject();
                image.put("mime", imageMime);
                image.put("data", imageBase64);
                root.put("image", image);
            }
        } catch (Exception ignored) {
            // JSONObject 不会对上面这些类型抛异常
        }
        return root;
    }
}
