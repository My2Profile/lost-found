using MongoDB.Bson;
using MongoDB.Bson.Serialization.Attributes;

namespace LostAndFound.Api.Features.Chat;

public sealed class ChatMessage
{
    [BsonId]
    [BsonGuidRepresentation(GuidRepresentation.Standard)]
    public Guid Id { get; init; } = Guid.NewGuid();

    [BsonGuidRepresentation(GuidRepresentation.Standard)]
    public Guid ConversationId { get; init; }

    [BsonGuidRepresentation(GuidRepresentation.Standard)]
    public Guid SenderUserId { get; init; }

    [BsonGuidRepresentation(GuidRepresentation.Standard)]
    public Guid ClientMessageId { get; init; }

    public string Text { get; init; } = string.Empty;

    public bool IsRead { get; set; }
    
    [BsonDateTimeOptions(Kind = DateTimeKind.Utc)]
    public DateTime CreatedAt { get; init; } = DateTime.UtcNow;
}