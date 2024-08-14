const paymentRepo = require("../../repositories/payment/index");
const midtrans = require("./midtrans");
const HttpError = require("../../utils/HttpError");
const { PaymentStatus } = require("../../utils/constants");
const { v4: uuidv4 } = require("uuid");
const {
    getPendingPayments,
    updatePaymentByIdInterval,
} = require("../../repositories/payment");
const { createNotificationByPaymentStatus } = require("./midtrans");
const {
    getHelperBookingByBookingId,
} = require("../../repositories/helperBooking");
const { updateSeat } = require("../../usecases/seat");
const moment = require("moment");

exports.getPaymentById = async (id, user) => {
    const data = await paymentRepo.getPaymentById(id);

    if (!data) {
        throw new HttpError({
            statusCode: 404,
            message: `Payment with ID ${id} does not exist!`,
        });
    }
    // cek kalo payment dengan ID tsb. memang milik user yg bersangkutan
    if (data.userId !== user.id) {
        throw new HttpError({
            statusCode: 403,
            message: "Not allowed to access other user's payment(s)!",
        });
    }
    return data;
};

exports.getPaymentsByUserId = async (userId, user) => {
    if (userId !== user.id) {
        throw new HttpError({
            statusCode: 403,
            message: "Not allowed to access other user's payment(s)!",
        });
    }
    const data = await paymentRepo.getPaymentsByUserId(userId);

    if (!data) {
        throw new HttpError({
            statusCode: 404,
            message: `Payment with user ID ${userId} does not exist!`,
        });
    }
    return data;
};

exports.addPayment = async (payload) => {
    const { totalPrice, user } = payload;

    if (!totalPrice) {
        throw new HttpError({
            statusCode: 400,
            message: "Field totalPrice must be filled!",
        });
    }
    let modifiedPayload = {
        ...payload,
        id: uuidv4(),
        userId: user.id,
    };
    const midtransPayment = await midtrans.generateMidtransTransaction(
        modifiedPayload
    );
    const { token: snapToken, redirect_url: snapLink } = midtransPayment;
    modifiedPayload = { ...modifiedPayload, snapToken, snapLink };

    return paymentRepo.addPayment(modifiedPayload);
};

exports.updatePaymentById = async (id, payload) => {
    const {
        user,
        transaction_status: transactionStatus,
        payment_type: method,
    } = payload;
    const toBeUpdated = await this.getPaymentById(id, user);

    // payment yg statusnya issued atau cancelled udah ga bisa di-update lagi
    if (toBeUpdated.status !== PaymentStatus.UNPAID) {
        return toBeUpdated;
    }
    let modifiedPayload = { ...payload };
    delete modifiedPayload.user; // delete the no longer used user data for payload

    if (transactionStatus) {
        const paymentStatus =
            midtrans.getPaymentStatusFromTransactionStatus(transactionStatus);
        modifiedPayload = { ...modifiedPayload, status: paymentStatus };
    }
    if (method) {
        modifiedPayload = { ...modifiedPayload, method };
    }
    modifiedPayload = { ...modifiedPayload, updatedAt: new Date() };

    return paymentRepo.updatePaymentById(id, modifiedPayload);
};

exports.deletePaymentById = async (id, user) => {
    const toBeDeleted = await this.getPaymentById(id, user);
    await paymentRepo.deletePaymentById(id);
    return toBeDeleted;
};

exports.checkExpiredTransactions = async (io) => {
    try {
        const pendingPayments = await getPendingPayments();

        if (!pendingPayments || pendingPayments.length === 0) {
            return;
        }

        for (const payment of pendingPayments) {
            const transactionCreatedAt = moment(payment.createdAt);

            // Check if the snap token has expired (e.g., 24 hours duration)
            if (moment().isAfter(transactionCreatedAt.add(24, "hours"))) {
                console.log("Payment expired:", payment.id);
                console.log("Payment status:", PaymentStatus.CANCELLED);
                console.log("Payment user ID:", payment.userId);
                const bookingId = await createNotificationByPaymentStatus(
                    payment.id,
                    payment.userId,
                    PaymentStatus.CANCELLED
                );
                console.log("Booking ID:", bookingId);

                const helperBooking = await getHelperBookingByBookingId(
                    bookingId
                );

                if (helperBooking && helperBooking.length > 0) {
                    for (const booking of helperBooking) {
                        await updateSeat(booking.seatId, {
                            isAvailable: true,
                        });
                    }

                    io.emit("seatsUpdate", {
                        message: "Seats Update",
                        flightId: helperBooking[0].Seat.flightId,
                        airlineClass: helperBooking[0].Seat.airlineClass,
                    });

                    io.emit("paymentFailed", {
                        message: `Pembayaran anda telah expired`,
                        highlight: `Order ID ${payment.id}`,
                        userId: payment.userId,
                    });

                    io.emit("paymentUpdate", {
                        message: "Payment Update",
                    });

                    io.emit("notificationUpdate", {
                        message: "Notification Update",
                    });
                }

                await updatePaymentByIdInterval(payment.id, {
                    status: PaymentStatus.CANCELLED,
                });
            } else {
                console.log("Payment still valid:", payment.id);
            }
        }
    } catch (error) {
        console.error("Error checking expired transactions:", error);
    }
};
